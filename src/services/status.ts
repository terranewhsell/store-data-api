/**
 * Service status.
 *
 * An ingest process that quietly stops is the most expensive failure there is,
 * because nobody notices until the data is already stale and the pages built from
 * it are wrong. On the coupons project a queue crawled for hours with nothing to
 * indicate it.
 *
 * So this answers the questions you would otherwise have to ask the database by
 * hand at three in the morning: how much do we have, how old is the oldest of it,
 * what has been failing today, and is the queue actually moving.
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '../db/client.ts'
import { appLocales, apps, ingestEvents, rankingSnapshots } from '../db/schema.ts'
import { allPacerStates } from '../lib/pacer.ts'
import { SOURCES, type Source } from '../normalize/contract.ts'
import { discoveryStats, queueStats, stalledJobs } from './worker.ts'

export interface SourceStatus {
  source: Source
  apps: number
  listings: number
  delisted: number
  markets: number
  oldestFetchedAt: string | null
  newestFetchedAt: string | null
  oldestAgeSeconds: number | null
  staleListings: number
  events24h: Record<string, number>
  breaker: {
    state: string
    consecutiveFailures: number
    blockedUntil: string | null
    lastError: string | null
    requestsSent: number
  }
}

export interface ServiceStatus {
  generated_at: string
  healthy: boolean
  warnings: string[]
  sources: SourceStatus[]
  totals: {
    apps: number
    listings: number
    rankings: number
    crossLinked: number
  }
  queue: {
    ingest: Record<string, number>
    discovery: Record<string, number>
    stalledRunningJobs: number
    movingLastHour: number
  }
}

async function countApps(source: Source): Promise<{ total: number; delisted: number }> {
  const db = getDb()
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      delisted: sql<number>`count(*) FILTER (WHERE ${apps.status} = 'delisted')::int`,
    })
    .from(apps)
    .where(eq(apps.source, source))
  return { total: Number(rows[0]?.total ?? 0), delisted: Number(rows[0]?.delisted ?? 0) }
}

async function listingStats(source: Source): Promise<{
  listings: number
  markets: number
  oldest: Date | null
  newest: Date | null
  stale: number
}> {
  const db = getDb()
  const rows = await db
    .select({
      listings: sql<number>`count(*)::int`,
      markets: sql<number>`count(DISTINCT (${appLocales.country} || ':' || ${appLocales.lang}))::int`,
      oldest: sql<Date | null>`min(${appLocales.fetchedAt})`,
      newest: sql<Date | null>`max(${appLocales.fetchedAt})`,
      stale: sql<number>`count(*) FILTER (WHERE ${appLocales.expiresAt} < now())::int`,
    })
    .from(appLocales)
    .where(eq(appLocales.source, source))

  const row = rows[0]
  return {
    listings: Number(row?.listings ?? 0),
    markets: Number(row?.markets ?? 0),
    oldest: row?.oldest ? new Date(row.oldest) : null,
    newest: row?.newest ? new Date(row.newest) : null,
    stale: Number(row?.stale ?? 0),
  }
}

async function events24h(source: Source): Promise<Record<string, number>> {
  const db = getDb()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const rows = await db
    .select({ outcome: ingestEvents.outcome, count: sql<number>`count(*)::int` })
    .from(ingestEvents)
    .where(and(eq(ingestEvents.source, source), gte(ingestEvents.createdAt, cutoff)))
    .groupBy(ingestEvents.outcome)

  const out: Record<string, number> = {}
  for (const row of rows) out[row.outcome] = Number(row.count)
  return out
}

/** Anything at all processed in the last hour. Zero here means it has stopped. */
async function movingLastHour(): Promise<number> {
  const db = getDb()
  const cutoff = new Date(Date.now() - 60 * 60 * 1000)
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ingestEvents)
    .where(gte(ingestEvents.createdAt, cutoff))
  return Number(rows[0]?.count ?? 0)
}

export async function getStatus(): Promise<ServiceStatus> {
  const db = getDb()
  const breakers = new Map(allPacerStates().map((s) => [s.source, s]))
  const now = Date.now()
  const warnings: string[] = []

  const sources: SourceStatus[] = []
  for (const source of SOURCES) {
    const [counts, listings, events] = await Promise.all([
      countApps(source),
      listingStats(source),
      events24h(source),
    ])
    const breaker = breakers.get(source)

    const failures =
      (events.blocked ?? 0) +
      (events.rate_limited ?? 0) +
      (events.malformed ?? 0) +
      (events.timeout ?? 0) +
      (events.unavailable ?? 0)
    const successes = events.ok ?? 0

    if (breaker?.state === 'blocked') {
      warnings.push(`${source}: circuit breaker is open (${breaker.lastError ?? 'no detail'})`)
    }
    if ((events.malformed ?? 0) > 0) {
      warnings.push(
        `${source}: ${events.malformed} malformed responses in 24h. A payload format may have changed.`,
      )
    }
    if (failures > successes && failures > 10) {
      warnings.push(`${source}: more failures than successes in the last 24h (${failures}/${successes})`)
    }
    if (listings.stale > 0 && listings.listings > 0 && listings.stale / listings.listings > 0.5) {
      warnings.push(`${source}: over half of the listings are past their TTL`)
    }

    sources.push({
      source,
      apps: counts.total,
      listings: listings.listings,
      delisted: counts.delisted,
      markets: listings.markets,
      oldestFetchedAt: listings.oldest?.toISOString() ?? null,
      newestFetchedAt: listings.newest?.toISOString() ?? null,
      oldestAgeSeconds: listings.oldest
        ? Math.floor((now - listings.oldest.getTime()) / 1000)
        : null,
      staleListings: listings.stale,
      events24h: events,
      breaker: {
        state: breaker?.state ?? 'ok',
        consecutiveFailures: breaker?.consecutiveFailures ?? 0,
        blockedUntil: breaker?.blockedUntil ? new Date(breaker.blockedUntil).toISOString() : null,
        lastError: breaker?.lastError ?? null,
        requestsSent: breaker?.requestsSent ?? 0,
      },
    })
  }

  const [totals, rankings, crossLinked, ingest, discovery, stalled, moving] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(apps),
    db.select({ count: sql<number>`count(*)::int` }).from(rankingSnapshots),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(apps)
      .where(and(eq(apps.source, 'play'), sql`${apps.iosId} IS NOT NULL`)),
    queueStats(),
    discoveryStats(),
    stalledJobs(),
    movingLastHour(),
  ])

  const pendingWork = (ingest.pending ?? 0) + (discovery.pending ?? 0)
  if (pendingWork > 0 && moving === 0) {
    warnings.push(
      `queue has ${pendingWork} pending items but nothing has been processed in the last hour. The worker may be stopped.`,
    )
  }
  if (stalled > 0) {
    warnings.push(`${stalled} jobs have been marked running for over 30 minutes. Likely orphaned by a crash.`)
  }

  return {
    generated_at: new Date().toISOString(),
    healthy: warnings.length === 0,
    warnings,
    sources,
    totals: {
      apps: Number(totals[0]?.count ?? 0),
      listings: sources.reduce((sum, s) => sum + s.listings, 0),
      rankings: Number(rankings[0]?.count ?? 0),
      crossLinked: Number(crossLinked[0]?.count ?? 0),
    },
    queue: {
      ingest,
      discovery,
      stalledRunningJobs: stalled,
      movingLastHour: moving,
    },
  }
}
