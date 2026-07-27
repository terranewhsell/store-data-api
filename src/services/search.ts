/**
 * Search.
 *
 * Local first, always. `/v1/search` queries our own Postgres full-text index; it
 * does not ask Google Play anything, ever. A user-triggered request to Play on
 * every query would get the IP banned on day one, and the brief says so
 * explicitly.
 *
 * When the local index has nothing, a live fallback is allowed against App Store
 * and Steam only, because both are official public APIs with no ban risk. Three
 * conditions govern it and none is optional:
 *
 *   1. The result is cached the moment it arrives, so the second identical search
 *      is local. Without that, every repeat of a popular query leaves the building.
 *   2. The route is rate limited per caller, in the route layer. It is the only
 *      endpoint a third party could use to point this service at Apple or Valve.
 *   3. It never blocks the response. There is a short deadline; whatever has not
 *      answered by then is dropped and the discovery is queued for the background
 *      worker instead. A user does not wait two seconds for a fallback.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { config } from '../config.ts'
import { getDb } from '../db/client.ts'
import { appLocales, apps } from '../db/schema.ts'
import { logger } from '../lib/logger.ts'
import type { Source } from '../normalize/contract.ts'
import * as ios from '../sources/ios.ts'
import * as steam from '../sources/steam.ts'
import { enqueueDiscovery } from './repository.ts'
import { serializeSummary, type AppSummary } from './serialize.ts'
import { PRIORITY } from './discovery.ts'

export interface SearchParams {
  term: string
  country: string
  lang: string
  sources: Source[]
  type?: 'app' | 'game'
  offset: number
  limit: number
  allowLive: boolean
}

export interface SearchResult {
  items: AppSummary[]
  total: number
  /** True when a live lookup contributed, so the caller knows why it was slower. */
  liveFallbackUsed: boolean
  /** Ids sent to the background worker because they are not in the index yet. */
  queuedForIngest: number
}

/**
 * Full-text query, `simple` dictionary.
 *
 * `simple` rather than a language configuration because the corpus is
 * multilingual: stemming Spanish text with the English dictionary produces wrong
 * stems, and we do not know the language of the query in advance.
 */
export async function searchLocal(params: SearchParams): Promise<{ items: AppSummary[]; total: number }> {
  const db = getDb()
  const term = params.term.trim()
  if (term.length === 0) return { items: [], total: 0 }

  const conditions = [
    eq(appLocales.country, params.country),
    eq(appLocales.lang, params.lang),
    eq(apps.status, 'active'),
  ]
  if (params.sources.length > 0) conditions.push(inArray(appLocales.source, params.sources))
  if (params.type) conditions.push(eq(appLocales.type, params.type))

  // Full-text match, plus a prefix match on the title so a partial word still
  // finds the obvious app. plainto_tsquery alone misses "goog" -> "Google".
  const matches = sql`(
    to_tsvector('simple', ${appLocales.searchText}) @@ plainto_tsquery('simple', ${term})
    OR lower(${appLocales.title}) LIKE ${`${term.toLowerCase()}%`}
  )`

  const where = and(...conditions, matches)

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appLocales)
    .innerJoin(apps, eq(appLocales.appId, apps.id))
    .where(where)

  const total = Number(totalRows[0]?.count ?? 0)
  if (total === 0) return { items: [], total: 0 }

  /**
   * Relevance, then popularity, then id.
   *
   * The id is not decoration: without a unique tie-break, two apps with the same
   * rank can swap places between requests, which makes a paginated crawl repeat
   * one and skip the other.
   */
  const rank = sql<number>`ts_rank_cd(to_tsvector('simple', ${appLocales.searchText}), plainto_tsquery('simple', ${term}))`
  const exactTitle = sql<number>`CASE WHEN lower(${appLocales.title}) = ${term.toLowerCase()} THEN 1 ELSE 0 END`

  const rows = await db
    .select({
      slug: apps.slug,
      status: apps.status,
      delistedAt: apps.delistedAt,
      iosId: apps.iosId,
      iosMatchConfidence: apps.iosMatchConfidence,
      iosMatchMethod: apps.iosMatchMethod,
      core: appLocales.core,
      extra: appLocales.extra,
      coverage: appLocales.coverage,
      country: appLocales.country,
      lang: appLocales.lang,
      source: appLocales.source,
      sourceId: appLocales.sourceId,
      fetchedAt: appLocales.fetchedAt,
      lastChangedAt: appLocales.lastChangedAt,
    })
    .from(appLocales)
    .innerJoin(apps, eq(appLocales.appId, apps.id))
    .where(where)
    .orderBy(
      sql`${exactTitle} DESC`,
      sql`${rank} DESC`,
      sql`coalesce(${appLocales.ratings}, 0) DESC`,
      sql`${appLocales.id} ASC`,
    )
    .limit(params.limit)
    .offset(params.offset)

  const items = (rows as unknown as Record<string, unknown>[]).map((row) =>
    serializeSummary(
      {
        slug: row.slug as string,
        status: row.status as string,
        delistedAt: (row.delistedAt as Date | null) ?? null,
        iosId: (row.iosId as string | null) ?? null,
        iosMatchConfidence: (row.iosMatchConfidence as number | null) ?? null,
        iosMatchMethod: (row.iosMatchMethod as string | null) ?? null,
      },
      {
        core: row.core,
        extra: row.extra,
        coverage: row.coverage,
        country: row.country as string,
        lang: row.lang as string,
        source: row.source as string,
        sourceId: row.sourceId as string,
        fetchedAt: row.fetchedAt as Date,
        lastChangedAt: row.lastChangedAt as Date,
      },
      { requestedMarket: { country: params.country, lang: params.lang } },
    ),
  )

  return { items, total }
}

/** Resolves to whatever finished in time; never rejects, never overruns. */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

/**
 * Live lookup against the two official APIs.
 *
 * Google Play is deliberately absent and must stay absent.
 * Everything found is queued for proper ingestion, so the next identical search
 * is served locally.
 */
async function liveDiscover(params: SearchParams): Promise<number> {
  const wantIos = params.sources.length === 0 || params.sources.includes('ios')
  const wantSteam = params.sources.length === 0 || params.sources.includes('steam')

  const tasks: Promise<{ source: Source; ids: string[] }>[] = []

  if (wantIos) {
    tasks.push(
      ios
        .search(params.term, { country: params.country, lang: params.lang, limit: 20 })
        .then((results) => ({
          source: 'ios' as const,
          ids: results.map((r) => `id${r.trackId}`),
        })),
    )
  }
  if (wantSteam) {
    tasks.push(
      steam.searchApps(params.term, 20).then((results) => ({
        source: 'steam' as const,
        ids: results.map((r) => r.appid),
      })),
    )
  }

  if (tasks.length === 0) return 0

  const settled = await Promise.allSettled(tasks)
  const entries: Parameters<typeof enqueueDiscovery>[0] = []

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue
    for (const id of outcome.value.ids) {
      entries.push({
        source: outcome.value.source,
        sourceId: id,
        origin: 'search',
        originDetail: { term: params.term, country: params.country, live: true },
        // Ahead of the long tail: somebody actually asked for this one.
        priority: PRIORITY.search - 10,
        depth: 0,
      })
    }
  }

  return enqueueDiscovery(entries)
}

export async function search(params: SearchParams): Promise<SearchResult> {
  const local = await searchLocal(params)

  if (local.total > 0) {
    return {
      items: local.items,
      total: local.total,
      liveFallbackUsed: false,
      queuedForIngest: 0,
    }
  }

  if (!params.allowLive || !config.LIVE_SEARCH_ENABLED) {
    return { items: [], total: 0, liveFallbackUsed: false, queuedForIngest: 0 }
  }

  // Bounded. Whatever has not answered by the deadline keeps running in the
  // background and its results still land in the discovery queue; the caller
  // simply does not wait for them.
  const queued = await withDeadline(
    liveDiscover(params).catch((error) => {
      logger.debug('live search fallback failed', { term: params.term, error: String(error) })
      return 0
    }),
    config.LIVE_SEARCH_TIMEOUT_MS,
    0,
  )

  // Anything the fallback managed to ingest within the deadline is already local.
  const second = queued > 0 ? await searchLocal(params) : { items: [], total: 0 }

  return {
    items: second.items,
    total: second.total,
    liveFallbackUsed: true,
    queuedForIngest: queued,
  }
}
