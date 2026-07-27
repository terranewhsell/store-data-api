/**
 * Read queries.
 *
 * Everything the API serves comes from our own database. No route reaches a store
 * on the request path, with one bounded exception documented in `search.ts`.
 *
 * Ordering is always fully determined. Every list ends with a tie-break on a
 * unique column, so the same data produces the same page every time. Without that
 * an app on a page boundary can appear twice or vanish between requests, which on
 * a paginated crawl of tens of thousands of listings means duplicated and missing
 * pages.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client.ts'
import { appLocales, apps, rankingItems, rankingSnapshots } from '../db/schema.ts'
import { nearestWarmMarket } from '../data/markets.ts'
import type { Source } from '../normalize/contract.ts'
import {
  serializeApp,
  serializeSummary,
  type AppRowLike,
  type AppSummary,
  type LocaleRowLike,
} from './serialize.ts'
import type { AppResource, RankingPosition } from '../normalize/contract.ts'

/**
 * Chart placements for a batch of apps, in one query.
 *
 * Batched rather than per-app because a 50-item page would otherwise fire 50
 * extra queries, and the whole reason the ranking tables exist is that these
 * pages carry the traffic.
 *
 * The key is `source:sourceId`, matching how rankings are stored: a chart lists
 * native store ids, not our internal ones.
 */
export async function rankingPositionsFor(
  entries: { source: string; sourceId: string }[],
  market: { country: string; lang: string },
): Promise<Map<string, RankingPosition[]>> {
  const out = new Map<string, RankingPosition[]>()
  if (entries.length === 0) return out

  const db = getDb()
  const sourceIds = [...new Set(entries.map((e) => e.sourceId))]

  const rows = await db
    .select({
      source: rankingSnapshots.source,
      collection: rankingSnapshots.collection,
      categoryId: rankingSnapshots.categoryId,
      country: rankingSnapshots.country,
      lang: rankingSnapshots.lang,
      capturedAt: rankingSnapshots.capturedAt,
      position: rankingItems.position,
      sourceId: rankingItems.sourceId,
    })
    .from(rankingItems)
    .innerJoin(rankingSnapshots, eq(rankingItems.snapshotId, rankingSnapshots.id))
    .where(
      and(
        inArray(rankingItems.sourceId, sourceIds),
        eq(rankingSnapshots.country, market.country),
        eq(rankingSnapshots.lang, market.lang),
      ),
    )

  for (const row of rows) {
    const key = `${row.source}:${row.sourceId}`
    const list = out.get(key) ?? []
    list.push({
      source: row.source as RankingPosition['source'],
      collection: row.collection,
      categoryId: row.categoryId,
      country: row.country,
      lang: row.lang,
      position: row.position,
      capturedAt: row.capturedAt.toISOString(),
    })
    out.set(key, list)
  }

  return out
}

const SELECTION = {
  slug: apps.slug,
  status: apps.status,
  delistedAt: apps.delistedAt,
  iosId: apps.iosId,
  iosMatchConfidence: apps.iosMatchConfidence,
  iosMatchMethod: apps.iosMatchMethod,
  core: appLocales.core,
  common: appLocales.common,
  extra: appLocales.extra,
  coverage: appLocales.coverage,
  country: appLocales.country,
  lang: appLocales.lang,
  source: appLocales.source,
  sourceId: appLocales.sourceId,
  fetchedAt: appLocales.fetchedAt,
  lastChangedAt: appLocales.lastChangedAt,
  localeId: appLocales.id,
}

type JoinedRow = {
  [K in keyof typeof SELECTION]: unknown
}

function split(row: Record<string, unknown>): { app: AppRowLike; locale: LocaleRowLike } {
  return {
    app: {
      slug: row.slug as string,
      status: row.status as string,
      delistedAt: (row.delistedAt as Date | null) ?? null,
      iosId: (row.iosId as string | null) ?? null,
      iosMatchConfidence: (row.iosMatchConfidence as number | null) ?? null,
      iosMatchMethod: (row.iosMatchMethod as string | null) ?? null,
    },
    locale: {
      core: row.core,
      common: row.common,
      extra: row.extra,
      coverage: row.coverage,
      country: row.country as string,
      lang: row.lang as string,
      source: row.source as string,
      sourceId: row.sourceId as string,
      fetchedAt: row.fetchedAt as Date,
      lastChangedAt: row.lastChangedAt as Date,
    },
  }
}

export interface ListFilters {
  sources: Source[]
  country: string
  lang: string
  type?: 'app' | 'game'
  genreId?: string
  developerId?: string
  includeDelisted: boolean
  sort: 'score' | 'ratings' | 'updated' | 'title' | 'price'
  order: 'asc' | 'desc'
}

export interface ListResult {
  items: AppSummary[]
  total: number
  servedMarket: { country: string; lang: string }
  marketFallback: boolean
}

function baseConditions(filters: ListFilters, market: { country: string; lang: string }): SQL[] {
  const conditions: SQL[] = [
    eq(appLocales.country, market.country),
    eq(appLocales.lang, market.lang),
  ]
  if (filters.sources.length > 0) {
    conditions.push(inArray(appLocales.source, filters.sources))
  }
  if (filters.type) conditions.push(eq(appLocales.type, filters.type))
  if (filters.genreId) conditions.push(eq(appLocales.genreId, filters.genreId))
  if (filters.developerId) conditions.push(eq(apps.developerId, filters.developerId))
  if (!filters.includeDelisted) conditions.push(eq(apps.status, 'active'))
  return conditions
}

function orderColumns(filters: ListFilters) {
  const direction = filters.order === 'asc' ? asc : desc
  const column =
    filters.sort === 'ratings'
      ? appLocales.ratings
      : filters.sort === 'updated'
        ? appLocales.updatedMs
        : filters.sort === 'title'
          ? appLocales.title
          : filters.sort === 'price'
            ? appLocales.price
            : appLocales.score

  // The trailing id is what makes pagination stable.
  return [direction(column), asc(appLocales.id)]
}

async function countFor(conditions: SQL[]): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appLocales)
    .innerJoin(apps, eq(appLocales.appId, apps.id))
    .where(and(...conditions))
  return Number(rows[0]?.count ?? 0)
}

/**
 * Lists apps for a market.
 *
 * If the requested market has nothing cached yet, the nearest warm market answers
 * and the response says so. That is how "all markets" is honest: any market can be
 * asked for, an unwarmed one is served from its closest neighbour and queued, and
 * the caller is told which of the two they got.
 */
export async function listApps(
  filters: ListFilters,
  page: { offset: number; limit: number },
): Promise<ListResult> {
  const db = getDb()
  const requested = { country: filters.country, lang: filters.lang }

  let market = requested
  let conditions = baseConditions(filters, market)
  let total = await countFor(conditions)
  let fallback = false

  if (total === 0) {
    const nearest = nearestWarmMarket(filters.country, filters.lang)
    if (nearest.country !== market.country || nearest.lang !== market.lang) {
      market = { country: nearest.country, lang: nearest.lang }
      conditions = baseConditions(filters, market)
      total = await countFor(conditions)
      fallback = total > 0
    }
  }

  const rows = await db
    .select(SELECTION)
    .from(appLocales)
    .innerJoin(apps, eq(appLocales.appId, apps.id))
    .where(and(...conditions))
    .orderBy(...orderColumns(filters))
    .limit(page.limit)
    .offset(page.offset)

  const list = rows as unknown as Record<string, unknown>[]
  const positions = await rankingPositionsFor(
    list.map((row) => ({ source: row.source as string, sourceId: row.sourceId as string })),
    market,
  )

  const items = list.map((row) => {
    const { app, locale } = split(row)
    return serializeSummary(app, locale, {
      requestedMarket: requested,
      rankings: positions.get(`${locale.source}:${locale.sourceId}`) ?? [],
    })
  })

  return { items, total, servedMarket: market, marketFallback: fallback }
}

/** One listing, by slug or by native id. Slug first: it is the permanent one. */
export async function getApp(
  identifier: { slug?: string; source?: Source; sourceId?: string },
  market: { country: string; lang: string },
): Promise<AppResource | null> {
  const db = getDb()

  const idCondition = identifier.slug
    ? eq(apps.slug, identifier.slug)
    : identifier.source && identifier.sourceId
      ? and(eq(apps.source, identifier.source), eq(apps.sourceId, identifier.sourceId))
      : null

  if (!idCondition) return null

  const exact = await db
    .select(SELECTION)
    .from(apps)
    .innerJoin(appLocales, eq(appLocales.appId, apps.id))
    .where(and(idCondition, eq(appLocales.country, market.country), eq(appLocales.lang, market.lang)))
    .limit(1)

  const found = (exact as unknown as Record<string, unknown>[])[0]
  if (found) {
    const { app, locale } = split(found)
    const positions = await rankingPositionsFor(
      [{ source: locale.source, sourceId: locale.sourceId }],
      market,
    )
    return serializeApp(app, locale, {
      requestedMarket: market,
      rankings: positions.get(`${locale.source}:${locale.sourceId}`) ?? [],
    })
  }

  // Market not warmed for this app: answer from whatever market we do have,
  // clearly flagged. Silence here would look like the app has no data.
  const anyMarket = await db
    .select(SELECTION)
    .from(apps)
    .innerJoin(appLocales, eq(appLocales.appId, apps.id))
    .where(idCondition)
    .orderBy(desc(appLocales.fetchedAt))
    .limit(1)

  const fallbackRow = (anyMarket as unknown as Record<string, unknown>[])[0]
  if (!fallbackRow) return null

  const { app, locale } = split(fallbackRow)
  const positions = await rankingPositionsFor(
    [{ source: locale.source, sourceId: locale.sourceId }],
    { country: locale.country, lang: locale.lang },
  )
  return serializeApp(app, locale, {
    requestedMarket: market,
    rankings: positions.get(`${locale.source}:${locale.sourceId}`) ?? [],
  })
}

export interface RankingResult {
  items: AppSummary[]
  /** Size of the chart Google published. */
  total: number
  /** How many of those listings we hold. Lower than `total` on a fresh catalogue. */
  ingested: number
  capturedAt: string | null
  expiresAt: string | null
  ageSeconds: number | null
  stale: boolean
}

/**
 * A ranking, in ranking order.
 *
 * The ordering comes from the stored position, never from a re-sort, so the same
 * snapshot always renders identically. These are the pages that carry the traffic;
 * an ordering that drifts between requests is a bug the whole site inherits.
 */
export async function getRanking(params: {
  source: Source
  collection: string
  categoryId: string
  country: string
  lang: string
  offset: number
  limit: number
}): Promise<RankingResult> {
  const db = getDb()

  const snapshots = await db
    .select()
    .from(rankingSnapshots)
    .where(
      and(
        eq(rankingSnapshots.source, params.source),
        eq(rankingSnapshots.collection, params.collection),
        eq(rankingSnapshots.categoryId, params.categoryId),
        eq(rankingSnapshots.country, params.country),
        eq(rankingSnapshots.lang, params.lang),
      ),
    )
    .limit(1)

  const snapshot = snapshots[0]
  if (!snapshot) {
    return {
      items: [],
      total: 0,
      ingested: 0,
      capturedAt: null,
      expiresAt: null,
      ageSeconds: null,
      stale: true,
    }
  }

  const rows = await db
    .select({
      position: rankingItems.position,
      ...SELECTION,
    })
    .from(rankingItems)
    .innerJoin(
      apps,
      and(eq(apps.sourceId, rankingItems.sourceId), eq(apps.source, params.source)),
    )
    .innerJoin(
      appLocales,
      and(
        eq(appLocales.appId, apps.id),
        eq(appLocales.country, params.country),
        eq(appLocales.lang, params.lang),
      ),
    )
    .where(eq(rankingItems.snapshotId, snapshot.id))
    .orderBy(asc(rankingItems.position))
    .limit(params.limit)
    .offset(params.offset)

  const items = (rows as unknown as Record<string, unknown>[]).map((row) => {
    const { app, locale } = split(row)
    return serializeSummary(app, locale, {
      requestedMarket: { country: params.country, lang: params.lang },
      // The placement is right here in the join; no second query needed.
      rankings: [
        {
          source: params.source,
          collection: params.collection,
          categoryId: params.categoryId,
          country: params.country,
          lang: params.lang,
          position: row.position as number,
          capturedAt: snapshot.capturedAt.toISOString(),
        },
      ],
    })
  })

  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - snapshot.capturedAt.getTime()) / 1000),
  )

  const ingestedRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rankingItems)
    .innerJoin(apps, and(eq(apps.sourceId, rankingItems.sourceId), eq(apps.source, params.source)))
    .innerJoin(
      appLocales,
      and(
        eq(appLocales.appId, apps.id),
        eq(appLocales.country, params.country),
        eq(appLocales.lang, params.lang),
      ),
    )
    .where(eq(rankingItems.snapshotId, snapshot.id))

  return {
    items,
    // The snapshot's own count, not the joined count: an app in the ranking whose
    // listing we have not ingested yet is still in the ranking.
    total: snapshot.itemCount,
    ingested: Number(ingestedRows[0]?.count ?? 0),
    capturedAt: snapshot.capturedAt.toISOString(),
    expiresAt: snapshot.expiresAt.toISOString(),
    ageSeconds,
    stale: snapshot.expiresAt.getTime() < Date.now(),
  }
}

export interface ExportCursor {
  lastChangedAt: string
  id: number
}

export interface ExportResult {
  items: AppResource[]
  nextCursor: ExportCursor | null
  hasMore: boolean
}

/**
 * Bulk export for a static build.
 *
 * Keyset pagination, not offset. A static site generator walking tens of
 * thousands of listings with OFFSET would get slower on every page and, worse,
 * would skip or duplicate rows whenever an ingest wrote something mid-crawl. The
 * cursor is (last_changed_at, id), which is unique and monotonic.
 *
 * `since` is compared against `last_changed_at`, not `fetched_at`, so a refresh
 * that returned identical data does not force a rebuild of that page.
 */
export async function exportApps(params: {
  country: string
  lang: string
  sources: Source[]
  since?: Date
  cursor?: ExportCursor
  limit: number
  includeDelisted: boolean
}): Promise<ExportResult> {
  const db = getDb()

  const conditions: SQL[] = [
    eq(appLocales.country, params.country),
    eq(appLocales.lang, params.lang),
  ]
  if (params.sources.length > 0) conditions.push(inArray(appLocales.source, params.sources))
  if (!params.includeDelisted) conditions.push(eq(apps.status, 'active'))
  if (params.since) conditions.push(gte(appLocales.lastChangedAt, params.since))

  if (params.cursor) {
    const cursorDate = new Date(params.cursor.lastChangedAt)
    const keyset = or(
      gt(appLocales.lastChangedAt, cursorDate),
      and(eq(appLocales.lastChangedAt, cursorDate), gt(appLocales.id, params.cursor.id)),
    )
    if (keyset) conditions.push(keyset)
  }

  const rows = await db
    .select(SELECTION)
    .from(appLocales)
    .innerJoin(apps, eq(appLocales.appId, apps.id))
    .where(and(...conditions))
    .orderBy(asc(appLocales.lastChangedAt), asc(appLocales.id))
    .limit(params.limit + 1)

  const list = rows as unknown as Record<string, unknown>[]
  const hasMore = list.length > params.limit
  const page = hasMore ? list.slice(0, params.limit) : list

  const positions = await rankingPositionsFor(
    page.map((row) => ({ source: row.source as string, sourceId: row.sourceId as string })),
    { country: params.country, lang: params.lang },
  )

  const items = page.map((row) => {
    const { app, locale } = split(row)
    return serializeApp(app, locale, {
      requestedMarket: { country: params.country, lang: params.lang },
      rankings: positions.get(`${locale.source}:${locale.sourceId}`) ?? [],
    })
  })

  const last = page[page.length - 1]
  const nextCursor =
    hasMore && last
      ? {
          lastChangedAt: (last.lastChangedAt as Date).toISOString(),
          id: Number(last.localeId),
        }
      : null

  return { items, nextCursor, hasMore }
}

/** Everything by one developer, used by the developer pages of a content site. */
export async function listByDeveloper(
  developerId: string,
  market: { country: string; lang: string },
  page: { offset: number; limit: number },
): Promise<ListResult> {
  return listApps(
    {
      sources: [],
      country: market.country,
      lang: market.lang,
      developerId,
      includeDelisted: false,
      sort: 'score',
      order: 'desc',
    },
    page,
  )
}

/** Cross-linked pairs, for a "also on iOS" module. */
export async function countCrossLinked(): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apps)
    .where(and(eq(apps.source, 'play'), isNotNull(apps.iosId)))
  return Number(rows[0]?.count ?? 0)
}
