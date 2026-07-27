/**
 * The ingest worker.
 *
 * Two tables, two jobs, on purpose:
 *
 *   discovery_queue  every id we have ever heard of, deduplicated on insert.
 *                    Cheap to fill, safe to fill in bursts.
 *   ingest_jobs      the paced work list, with attempts and backoff.
 *
 * `promoteDiscoveries` is the valve between them. Discovery can find fifty
 * thousand ids in a minute; the valve releases them into the fetch queue at a
 * rate we control. Collapsing the two tables would mean a burst of discoveries
 * becoming a burst of outbound requests, which is exactly how an IP gets banned.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED, so more than one worker can run without
 * two of them fetching the same listing.
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { config } from '../config.ts'
import { getDb } from '../db/client.ts'
import { discoveryQueue, ingestJobs } from '../db/schema.ts'
import { logger } from '../lib/logger.ts'
import { BreakerOpenError, pacers, sleep } from '../lib/pacer.ts'
import { isSourceError } from '../lib/source-errors.ts'
import type { Source } from '../normalize/contract.ts'
import { ingestApp } from './ingest.ts'
import { saveSourceHealth } from './repository.ts'

export interface JobParams {
  sourceId: string
  country: string
  lang: string
  resolveIosMatch?: boolean
  markPopular?: boolean
}

/**
 * Moves discovered ids into the fetch queue, highest priority first.
 * Nothing else creates app-fetch jobs, so this is the single rate valve.
 */
export async function promoteDiscoveries(opts: {
  limit: number
  country: string
  lang: string
  source?: Source
}): Promise<number> {
  const db = getDb()

  const conditions = [eq(discoveryQueue.status, 'pending')]
  if (opts.source) conditions.push(eq(discoveryQueue.source, opts.source))

  const pending = await db
    .select()
    .from(discoveryQueue)
    .where(and(...conditions))
    .orderBy(asc(discoveryQueue.priority), asc(discoveryQueue.depth), asc(discoveryQueue.id))
    .limit(opts.limit)

  if (pending.length === 0) return 0

  let promoted = 0
  for (const row of pending) {
    const params: JobParams = {
      sourceId: row.sourceId,
      country: opts.country,
      lang: opts.lang,
      // Only worth spending extra Apple calls on apps that actually chart.
      resolveIosMatch: row.source === 'play' && row.origin === 'ranking',
      markPopular: row.origin === 'ranking',
    }

    await db
      .insert(ingestJobs)
      .values({
        kind: 'app',
        source: row.source,
        params: params as never,
        dedupeKey: `app:${row.source}:${row.sourceId}:${opts.country}:${opts.lang}`,
        priority: row.priority,
      })
      .onConflictDoNothing({ target: ingestJobs.dedupeKey })

    await db
      .update(discoveryQueue)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(discoveryQueue.id, row.id))

    promoted += 1
  }

  logger.info('discoveries promoted to the fetch queue', { promoted, ...opts })
  return promoted
}

export interface ClaimedJob {
  id: number
  kind: string
  source: Source
  params: JobParams
  attempts: number
}

/** Atomically takes the next due jobs. Safe with several workers running. */
export async function claimJobs(limit: number): Promise<ClaimedJob[]> {
  const db = getDb()
  const rows = await db.execute(sql`
    UPDATE ingest_jobs
       SET status = 'running', updated_at = now()
     WHERE id IN (
       SELECT id FROM ingest_jobs
        WHERE status = 'pending'
          AND next_attempt_at <= now()
        ORDER BY priority ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, source, params, attempts
  `)

  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
    id: number | string
    kind: string
    source: string
    params: JobParams
    attempts: number
  }[]

  return list.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    source: r.source as Source,
    params: typeof r.params === 'string' ? (JSON.parse(r.params) as JobParams) : r.params,
    attempts: Number(r.attempts),
  }))
}

async function completeJob(id: number): Promise<void> {
  const db = getDb()
  await db
    .update(ingestJobs)
    .set({ status: 'done', updatedAt: new Date(), lastError: null, lastErrorKind: null })
    .where(eq(ingestJobs.id, id))
}

/**
 * Reschedules with exponential backoff, or gives up after MAX_ATTEMPTS.
 * A job that has exhausted its attempts is marked failed, not deleted: a queue
 * that silently loses work is the failure nobody notices.
 */
async function failJob(
  job: ClaimedJob,
  error: unknown,
  opts: { permanent?: boolean } = {},
): Promise<void> {
  const db = getDb()
  const attempts = job.attempts + 1
  const kind = isSourceError(error) ? error.kind : 'unavailable'
  const message = error instanceof Error ? error.message : String(error)

  const permanent = opts.permanent || kind === 'not_found' || attempts >= config.MAX_ATTEMPTS

  if (permanent) {
    await db
      .update(ingestJobs)
      .set({
        status: kind === 'not_found' ? 'done' : 'failed',
        attempts,
        lastError: message.slice(0, 2000),
        lastErrorKind: kind,
        updatedAt: new Date(),
      })
      .where(eq(ingestJobs.id, job.id))
    return
  }

  const backoffMs = Math.min(config.BACKOFF_MAX_MS, config.BACKOFF_BASE_MS * 2 ** (attempts - 1))
  await db
    .update(ingestJobs)
    .set({
      status: 'pending',
      attempts,
      nextAttemptAt: new Date(Date.now() + backoffMs),
      lastError: message.slice(0, 2000),
      lastErrorKind: kind,
      updatedAt: new Date(),
    })
    .where(eq(ingestJobs.id, job.id))
}

/** Marks a source's whole pending queue as waiting while its breaker is open. */
async function deferSource(source: Source, untilMs: number): Promise<void> {
  const db = getDb()
  await db
    .update(ingestJobs)
    .set({ nextAttemptAt: new Date(untilMs), updatedAt: new Date() })
    .where(and(eq(ingestJobs.source, source), eq(ingestJobs.status, 'pending')))
}

export async function runJob(job: ClaimedJob): Promise<void> {
  const db = getDb()

  try {
    if (job.kind !== 'app') {
      logger.warn('unknown job kind, marking done', { kind: job.kind, id: job.id })
      await completeJob(job.id)
      return
    }

    const outcome = await ingestApp(job.source, job.params.sourceId, {
      country: job.params.country,
      lang: job.params.lang,
      ...(job.params.resolveIosMatch !== undefined
        ? { resolveIosMatch: job.params.resolveIosMatch }
        : {}),
      ...(job.params.markPopular !== undefined ? { markPopular: job.params.markPopular } : {}),
    })

    if (outcome.ok) {
      await completeJob(job.id)
      await db
        .update(discoveryQueue)
        .set({ status: 'ingested', updatedAt: new Date() })
        .where(
          and(
            eq(discoveryQueue.source, job.source),
            eq(discoveryQueue.sourceId, job.params.sourceId),
          ),
        )
      return
    }

    // Failed the quality gate: retry later, the listing may fill in.
    await failJob(job, new Error(`quality gate: ${outcome.reason ?? 'unknown'}`), {
      permanent: outcome.reason === 'not_found',
    })
  } catch (error) {
    if (error instanceof BreakerOpenError) {
      // Not this job's fault. Push the whole source out and leave the job pending.
      await deferSource(job.source, Date.now() + error.retryAfterMs)
      await db
        .update(ingestJobs)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(eq(ingestJobs.id, job.id))
      return
    }
    await failJob(job, error)
  }
}

/** Persists the in-memory breaker state so a restart does not forget it. */
async function syncHealth(): Promise<void> {
  for (const pacer of Object.values(pacers)) {
    const state = pacer.state
    await saveSourceHealth({
      source: state.source,
      state: state.state,
      consecutiveFailures: state.consecutiveFailures,
      blockedUntil: state.blockedUntil ? new Date(state.blockedUntil) : null,
      lastError: state.lastError,
      ...(state.state === 'ok' ? { lastSuccessAt: new Date() } : {}),
    })
  }
}

export interface WorkerHandle {
  stop: () => void
  done: Promise<void>
}

/**
 * The long-running worker. Off by default: starting a process should never begin
 * hitting the stores by surprise.
 */
export function startWorker(): WorkerHandle {
  let running = true
  let healthTick = 0

  const done = (async () => {
    logger.info('ingest worker started', { concurrency: config.INGEST_WORKER_CONCURRENCY })

    while (running) {
      try {
        const jobs = await claimJobs(config.INGEST_WORKER_CONCURRENCY)

        if (jobs.length === 0) {
          await sleep(config.INGEST_POLL_INTERVAL_MS)
        } else {
          // Sequential per tick. The pacer serialises per source anyway, and
          // running them here in order keeps the log readable.
          for (const job of jobs) {
            if (!running) break
            await runJob(job)
          }
        }

        if (++healthTick % 20 === 0) await syncHealth()
      } catch (error) {
        logger.error('worker loop error', { error: String(error) })
        await sleep(config.INGEST_POLL_INTERVAL_MS * 5)
      }
    }

    await syncHealth().catch(() => undefined)
    logger.info('ingest worker stopped')
  })()

  return {
    stop: () => {
      running = false
    },
    done,
  }
}

/** Drains up to `max` jobs and returns. Used by the CLI and by tests. */
export async function drainQueue(max: number): Promise<{ processed: number }> {
  let processed = 0
  while (processed < max) {
    const jobs = await claimJobs(1)
    const job = jobs[0]
    if (!job) break
    await runJob(job)
    processed += 1
  }
  await syncHealth().catch(() => undefined)
  return { processed }
}

/** Queue depth by status, for the status route. */
export async function queueStats(): Promise<Record<string, number>> {
  const db = getDb()
  const rows = await db
    .select({ status: ingestJobs.status, count: sql<number>`count(*)::int` })
    .from(ingestJobs)
    .groupBy(ingestJobs.status)

  const out: Record<string, number> = {}
  for (const row of rows) out[row.status] = Number(row.count)
  return out
}

export async function discoveryStats(): Promise<Record<string, number>> {
  const db = getDb()
  const rows = await db
    .select({ status: discoveryQueue.status, count: sql<number>`count(*)::int` })
    .from(discoveryQueue)
    .groupBy(discoveryQueue.status)

  const out: Record<string, number> = {}
  for (const row of rows) out[row.status] = Number(row.count)
  return out
}

/** Jobs whose backoff has expired but that nobody has picked up. */
export async function stalledJobs(olderThanMinutes = 30): Promise<number> {
  const db = getDb()
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ingestJobs)
    .where(and(eq(ingestJobs.status, 'running'), lte(ingestJobs.updatedAt, cutoff)))
  return Number(rows[0]?.count ?? 0)
}
