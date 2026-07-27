/**
 * Persistence.
 *
 * Two invariants live here and nowhere else:
 *
 *  1. A slug is written once. Every path that touches `apps` goes through
 *     `upsertApp`, which never overwrites an existing slug, so an app renamed in
 *     the store keeps its URL and whatever ranking that URL earned.
 *
 *  2. A row is only marked as changed when its content actually changed.
 *     `fetched_at` moves on every refresh; `last_changed_at` moves only when the
 *     digest differs. The incremental export depends on that distinction, and
 *     without it a static build rebuilds every page on every refresh.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client.ts'
import {
  appLocales,
  apps,
  discoveryQueue,
  ingestEvents,
  matchCandidates,
  rankingItems,
  rankingSnapshots,
  rawPayloads,
  sourceHealth,
} from '../db/schema.ts'
import { appSlug, disambiguateSlug } from '../lib/slug.ts'
import { logger } from '../lib/logger.ts'
import type { NormalizedApp, Source } from '../normalize/contract.ts'
import type { SourceName } from '../lib/source-errors.ts'
import { contentDigest } from '../normalize/shared.ts'

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

interface PgErrorLike {
  code?: string
  constraint?: string
  constraint_name?: string
  detail?: string
  message?: string
  cause?: unknown
}

/**
 * Drizzle wraps driver errors in a DrizzleQueryError and puts the real Postgres
 * error on `cause`, so the SQLSTATE is never on the object you catch. Walking the
 * chain is what makes the difference between recovering from a slug collision and
 * crashing on one, and slug collisions are routine: "Google Translate" exists on
 * both Google Play and the App Store.
 */
function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error

  for (let depth = 0; depth < 5 && current != null; depth++) {
    const e = current as PgErrorLike
    const codeMatches =
      e.code === UNIQUE_VIOLATION || String(e.message ?? '').includes(UNIQUE_VIOLATION)

    if (codeMatches) {
      if (!constraint) return true
      const haystack = [e.constraint_name, e.constraint, e.detail, e.message]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
      if (haystack.includes(constraint)) return true
    }
    current = e.cause
  }
  return false
}

export interface UpsertAppInput {
  source: Source
  sourceId: string
  title: string
  type: 'app' | 'game'
  genreId: string | null
  developerId: string | null
  isPopular?: boolean
}

export interface AppRecord {
  id: number
  slug: string
  source: string
  sourceId: string
  status: string
  delistedAt: Date | null
  isPopular: boolean
  iosId: string | null
  iosMatchConfidence: number | null
  iosMatchMethod: string | null
}

/**
 * Creates or refreshes the identity row. Returns the persisted record, including
 * the slug, which callers must treat as immutable.
 */
export async function upsertApp(input: UpsertAppInput): Promise<AppRecord> {
  const db = getDb()

  const existing = await db
    .select()
    .from(apps)
    .where(and(eq(apps.source, input.source), eq(apps.sourceId, input.sourceId)))
    .limit(1)

  const found = existing[0]
  if (found) {
    // Note what is NOT updated: `slug`. Ever.
    await db
      .update(apps)
      .set({
        type: input.type,
        genreId: input.genreId,
        developerId: input.developerId,
        ...(input.isPopular ? { isPopular: true } : {}),
        status: 'active',
        delistedAt: null,
        lastCheckedAt: new Date(),
        lastSeenAt: new Date(),
      })
      .where(eq(apps.id, found.id))

    return {
      id: found.id,
      slug: found.slug,
      source: found.source,
      sourceId: found.sourceId,
      status: 'active',
      delistedAt: null,
      isPopular: found.isPopular || (input.isPopular ?? false),
      iosId: found.iosId,
      iosMatchConfidence: found.iosMatchConfidence,
      iosMatchMethod: found.iosMatchMethod,
    }
  }

  const preferred = appSlug({
    title: input.title,
    source: input.source,
    sourceId: input.sourceId,
  })

  // Two attempts: the readable slug, then the deterministic disambiguated one.
  // Both are stable for a given app, so a retry never produces a third value.
  for (const slug of [preferred, disambiguateSlug(preferred, input.source, input.sourceId)]) {
    try {
      const inserted = await db
        .insert(apps)
        .values({
          source: input.source,
          sourceId: input.sourceId,
          slug,
          type: input.type,
          genreId: input.genreId,
          developerId: input.developerId,
          isPopular: input.isPopular ?? false,
          status: 'active',
          lastCheckedAt: new Date(),
        })
        .returning()

      const row = inserted[0]
      if (!row) throw new Error('insert into apps returned no row')
      return {
        id: row.id,
        slug: row.slug,
        source: row.source,
        sourceId: row.sourceId,
        status: row.status,
        delistedAt: row.delistedAt,
        isPopular: row.isPopular,
        iosId: row.iosId,
        iosMatchConfidence: row.iosMatchConfidence,
        iosMatchMethod: row.iosMatchMethod,
      }
    } catch (error) {
      if (isUniqueViolation(error, 'apps_slug_key')) {
        logger.debug('slug collision, disambiguating', { slug, sourceId: input.sourceId })
        continue
      }
      if (isUniqueViolation(error, 'apps_source_source_id_key')) {
        // Another worker inserted it between our select and our insert.
        return upsertApp(input)
      }
      throw error
    }
  }

  throw new Error(`could not allocate a slug for ${input.source}:${input.sourceId}`)
}

export interface StoreLocaleResult {
  changed: boolean
  localeId: number
}

/** Writes the normalized listing for one market. */
export async function storeLocale(
  appRecord: AppRecord,
  normalized: NormalizedApp,
  ttlSeconds: number,
): Promise<StoreLocaleResult> {
  const db = getDb()
  const digest = contentDigest(normalized.core)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)

  const previous = await db
    .select({ id: appLocales.id, contentHash: appLocales.contentHash, lastChangedAt: appLocales.lastChangedAt })
    .from(appLocales)
    .where(
      and(
        eq(appLocales.appId, appRecord.id),
        eq(appLocales.country, normalized.country),
        eq(appLocales.lang, normalized.lang),
      ),
    )
    .limit(1)

  const before = previous[0]
  const changed = before === undefined || before.contentHash !== digest

  const values = {
    appId: appRecord.id,
    source: normalized.source,
    sourceId: normalized.sourceId,
    country: normalized.country,
    lang: normalized.lang,
    core: normalized.core,
    common: normalized.common,
    extra: normalized.extra,
    coverage: { fieldCoverage: normalized.coverage, derivedFields: normalized.derived },
    searchText: normalized.searchText,
    title: normalized.core.title,
    developer: normalized.core.developer,
    type: normalized.core.type,
    genreId: normalized.core.genreId,
    score: normalized.core.score,
    ratings: normalized.core.ratings,
    price: normalized.core.price,
    free: normalized.core.free,
    minInstalls: normalized.core.minInstalls,
    updatedMs: normalized.core.updated,
    contentHash: digest,
    fetchedAt: now,
    expiresAt,
    ...(changed ? { lastChangedAt: now } : {}),
  }

  const result = await db
    .insert(appLocales)
    .values(values)
    .onConflictDoUpdate({
      target: [appLocales.appId, appLocales.country, appLocales.lang],
      set: values,
    })
    .returning({ id: appLocales.id })

  return { changed, localeId: result[0]?.id ?? before?.id ?? 0 }
}

/**
 * An app that has vanished from the store is flagged, never deleted. Deleting it
 * leaves an empty page behind; flagging lets the front end decide.
 */
export async function markDelisted(source: Source, sourceId: string): Promise<void> {
  const db = getDb()
  await db
    .update(apps)
    .set({ status: 'delisted', delistedAt: new Date(), lastCheckedAt: new Date() })
    .where(and(eq(apps.source, source), eq(apps.sourceId, sourceId)))
}

/**
 * Flags the apps in a ranking as popular, which is what earns them the short TTL.
 *
 * Chunked: a chart can carry hundreds of ids and Postgres has a bind-parameter
 * ceiling per statement. Chunking also keeps a single oversized IN list from
 * turning into a sequential scan.
 */
export async function markPopular(source: Source, sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return
  const db = getDb()
  const CHUNK = 500

  for (let i = 0; i < sourceIds.length; i += CHUNK) {
    const chunk = sourceIds.slice(i, i + CHUNK)
    await db
      .update(apps)
      .set({ isPopular: true })
      .where(and(eq(apps.source, source), inArray(apps.sourceId, chunk)))
  }
}

/** The untouched source response, kept so normalization can be re-run later. */
export async function storeRaw(input: {
  source: Source
  kind: string
  sourceId?: string | null
  country?: string | null
  lang?: string | null
  url?: string | null
  httpStatus?: number | null
  payload: unknown
}): Promise<void> {
  const db = getDb()
  await db.insert(rawPayloads).values({
    source: input.source,
    kind: input.kind,
    sourceId: input.sourceId ?? null,
    country: input.country ?? null,
    lang: input.lang ?? null,
    url: input.url ?? null,
    httpStatus: input.httpStatus ?? null,
    payload: input.payload as never,
  })
}

/**
 * Stores a payload, replacing any previous one for the same key.
 *
 * `raw_payloads` is append-only everywhere else, and deliberately so: the
 * history is what lets a bad normalisation be traced. Page HTML is the
 * exception, because at 338 KB a copy an append-only history of it grows without
 * bound. Only the most recent page for an app and market is worth keeping, and
 * that keeps the corpus a fixed cost rather than one that grows with every
 * refresh.
 */
export async function storeRawReplacing(input: {
  source: Source
  kind: string
  sourceId: string
  country?: string | null
  lang?: string | null
  url?: string | null
  payload: unknown
}): Promise<void> {
  const db = getDb()

  const conditions = [
    eq(rawPayloads.source, input.source),
    eq(rawPayloads.kind, input.kind),
    eq(rawPayloads.sourceId, input.sourceId),
  ]
  if (input.country) conditions.push(eq(rawPayloads.country, input.country))
  if (input.lang) conditions.push(eq(rawPayloads.lang, input.lang))

  await db.delete(rawPayloads).where(and(...conditions))
  await storeRaw(input)
}

export async function recordEvent(input: {
  source: Source
  kind: string
  sourceId?: string | null
  outcome: string
  durationMs?: number | null
  detail?: Record<string, unknown>
}): Promise<void> {
  const db = getDb()
  await db.insert(ingestEvents).values({
    source: input.source,
    kind: input.kind,
    sourceId: input.sourceId ?? null,
    outcome: input.outcome,
    durationMs: input.durationMs ?? null,
    detail: (input.detail ?? {}) as never,
  })
}

export async function saveSourceHealth(input: {
  /** Wider than the contract `Source`: auxiliary providers get a row too. */
  source: SourceName
  state: string
  consecutiveFailures: number
  blockedUntil: Date | null
  lastError: string | null
  lastSuccessAt?: Date | null
}): Promise<void> {
  const db = getDb()
  const values = {
    source: input.source,
    state: input.state,
    consecutiveFailures: input.consecutiveFailures,
    blockedUntil: input.blockedUntil,
    lastError: input.lastError,
    ...(input.lastSuccessAt ? { lastSuccessAt: input.lastSuccessAt } : {}),
    updatedAt: new Date(),
  }
  await db
    .insert(sourceHealth)
    .values(values)
    .onConflictDoUpdate({ target: sourceHealth.source, set: values })
}

/** Replaces the current ranking for a (source, collection, category, market). */
export async function storeRanking(input: {
  source: Source
  collection: string
  categoryId: string
  country: string
  lang: string
  sourceIds: string[]
  ttlSeconds: number
}): Promise<number> {
  const db = getDb()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000)

  const values = {
    source: input.source,
    collection: input.collection,
    categoryId: input.categoryId,
    country: input.country,
    lang: input.lang,
    itemCount: input.sourceIds.length,
    capturedAt: now,
    expiresAt,
  }

  const snapshot = await db
    .insert(rankingSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [
        rankingSnapshots.source,
        rankingSnapshots.collection,
        rankingSnapshots.categoryId,
        rankingSnapshots.country,
        rankingSnapshots.lang,
      ],
      set: values,
    })
    .returning({ id: rankingSnapshots.id })

  const snapshotId = snapshot[0]?.id
  if (snapshotId === undefined) throw new Error('ranking snapshot upsert returned no id')

  await db.delete(rankingItems).where(eq(rankingItems.snapshotId, snapshotId))
  if (input.sourceIds.length > 0) {
    await db.insert(rankingItems).values(
      input.sourceIds.map((sourceId, index) => ({
        snapshotId,
        position: index + 1,
        sourceId,
      })),
    )
  }
  return snapshotId
}

/**
 * Records discovered ids. Deduplicated here, before anything is enqueued, so a
 * ranking refresh that returns the same 500 apps does not create 500 jobs.
 */
export async function enqueueDiscovery(
  entries: {
    source: Source
    sourceId: string
    origin: string
    originDetail?: Record<string, unknown>
    priority?: number
    depth?: number
  }[],
): Promise<number> {
  if (entries.length === 0) return 0
  const db = getDb()

  const seen = new Set<string>()
  const rows = entries
    .filter((e) => {
      const key = `${e.source}:${e.sourceId}`
      if (seen.has(key) || e.sourceId.trim() === '') return false
      seen.add(key)
      return true
    })
    .map((e) => ({
      source: e.source,
      sourceId: e.sourceId,
      origin: e.origin,
      originDetail: (e.originDetail ?? {}) as never,
      priority: e.priority ?? 100,
      depth: e.depth ?? 0,
      status: 'pending' as const,
    }))

  if (rows.length === 0) return 0

  const inserted = await db
    .insert(discoveryQueue)
    .values(rows)
    .onConflictDoNothing({ target: [discoveryQueue.source, discoveryQueue.sourceId] })
    .returning({ id: discoveryQueue.id })

  return inserted.length
}

export async function saveMatchCandidates(
  appDbId: number,
  candidates: {
    candidateSource: string
    candidateSourceId: string
    candidateTitle: string | null
    candidateDeveloper: string | null
    titleSimilarity: number
    developerSimilarity: number
    confidence: number
    decision: 'accepted' | 'rejected' | 'review'
    method: string
  }[],
): Promise<void> {
  if (candidates.length === 0) return
  const db = getDb()
  for (const candidate of candidates) {
    await db
      .insert(matchCandidates)
      .values({ appId: appDbId, ...candidate })
      .onConflictDoUpdate({
        target: [matchCandidates.appId, matchCandidates.candidateSourceId],
        set: { ...candidate },
      })
  }
}

export async function setIosMatch(
  appDbId: number,
  match: { iosId: string; confidence: number; method: string } | null,
): Promise<void> {
  const db = getDb()
  await db
    .update(apps)
    .set({
      iosId: match?.iosId ?? null,
      iosMatchConfidence: match?.confidence ?? null,
      iosMatchMethod: match?.method ?? null,
    })
    .where(eq(apps.id, appDbId))
}
