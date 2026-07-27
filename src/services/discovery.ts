/**
 * Where the apps come from.
 *
 * Fetching one listing is easy; deciding WHICH listings to fetch is the actual
 * problem, because Google Play cannot be enumerated. There is no "give me every
 * app", so the catalogue has to be grown, in this order of value per unit of
 * risk:
 *
 *   1. Rankings by category and country. Three collections across 54 ingestable
 *      categories per market: thousands of apps, and specifically the ones with
 *      traffic. Best effort-to-value ratio by a wide margin, so it seeds first.
 *   2. Similarity and same-developer traversal. Every listing points at more
 *      listings, so the corpus grows from the seeds with no external input.
 *      Breadth-first, depth-bounded, visited-checked.
 *   3. Term search, for the long tail that never charts.
 *   4. Steam publishes its whole catalogue in one call, so the problem there is
 *      not discovery but volume: it is prioritised, not swallowed whole.
 *   5. Apple publishes official charts per country, plus the search API.
 *
 * The hard rule, and the reason this file does not fetch any listing:
 * DISCOVERING AND DOWNLOADING ARE SEPARATE STEPS. Discovery is cheap and safe,
 * download is expensive and blockable. A burst of discoveries must never become a
 * burst of requests.
 */
import { PLAY_INGESTABLE_CATEGORY_IDS } from '../data/categories.ts'
import { logger } from '../lib/logger.ts'
import { isSourceError } from '../lib/source-errors.ts'
import * as play from '../sources/play.ts'
import * as ios from '../sources/ios.ts'
import * as steam from '../sources/steam.ts'
import { enqueueDiscovery, recordEvent, storeRanking, storeRaw, markPopular } from './repository.ts'
import { config } from '../config.ts'

/** Lower runs first. Rankings before similars before the long tail. */
export const PRIORITY = {
  ranking: 10,
  chart: 15,
  similar: 40,
  developer: 50,
  search: 70,
  catalog: 90,
} as const

export const MAX_TRAVERSAL_DEPTH = 3

export interface DiscoveryResult {
  discovered: number
  enqueued: number
}

/**
 * Seeds from one Play ranking, and stores the ranking itself: the same request
 * answers "which apps matter" and "what does /v1/top serve".
 */
export async function discoverFromPlayRanking(params: {
  collection: 'TOP_FREE' | 'TOP_PAID' | 'GROSSING'
  categoryId: string
  country: string
  lang: string
  num?: number
}): Promise<DiscoveryResult> {
  const started = Date.now()
  const num = params.num ?? 100

  // GAME_WORLD is in our canonical list but not in Play's taxonomy; asking for it
  // throws. Callers filter, and this is the second line of defence.
  if (!PLAY_INGESTABLE_CATEGORY_IDS.includes(params.categoryId)) {
    logger.debug('skipping category with no Play mapping', { category: params.categoryId })
    return { discovered: 0, enqueued: 0 }
  }

  try {
    const items = await play.fetchList({
      collection: params.collection,
      category: params.categoryId,
      num,
      lang: params.lang,
      country: params.country,
    })

    await storeRaw({
      source: 'play',
      kind: 'list',
      sourceId: `${params.collection}:${params.categoryId}`,
      country: params.country,
      lang: params.lang,
      payload: items,
    })

    const appIds = items
      .map((item) => (typeof item.appId === 'string' ? item.appId : null))
      .filter((id): id is string => id !== null)

    await storeRanking({
      source: 'play',
      collection: params.collection,
      categoryId: params.categoryId,
      country: params.country,
      lang: params.lang,
      sourceIds: appIds,
      ttlSeconds: config.TTL_RANKING,
    })

    const enqueued = await enqueueDiscovery(
      appIds.map((appId) => ({
        source: 'play' as const,
        sourceId: appId,
        origin: 'ranking',
        originDetail: {
          collection: params.collection,
          category: params.categoryId,
          country: params.country,
        },
        priority: PRIORITY.ranking,
        depth: 0,
      })),
    )

    // Charting apps get the short TTL: they change and they carry the traffic.
    await markPopular('play', appIds)

    await recordEvent({
      source: 'play',
      kind: 'discover_ranking',
      sourceId: `${params.collection}:${params.categoryId}`,
      outcome: 'ok',
      durationMs: Date.now() - started,
      detail: { country: params.country, found: appIds.length, enqueued },
    })

    return { discovered: appIds.length, enqueued }
  } catch (error) {
    await recordEvent({
      source: 'play',
      kind: 'discover_ranking',
      sourceId: `${params.collection}:${params.categoryId}`,
      outcome: isSourceError(error) ? error.kind : 'unavailable',
      durationMs: Date.now() - started,
      detail: { country: params.country, error: String(error) },
    })
    throw error
  }
}

/** Breadth-first expansion from an app we already have. */
export async function discoverFromPlaySimilar(params: {
  appId: string
  country: string
  lang: string
  depth: number
}): Promise<DiscoveryResult> {
  if (params.depth >= MAX_TRAVERSAL_DEPTH) return { discovered: 0, enqueued: 0 }

  const items = await play.fetchSimilar({
    appId: params.appId,
    country: params.country,
    lang: params.lang,
  })
  const appIds = items
    .map((item) => (typeof item.appId === 'string' ? item.appId : null))
    .filter((id): id is string => id !== null)

  const enqueued = await enqueueDiscovery(
    appIds.map((appId) => ({
      source: 'play' as const,
      sourceId: appId,
      origin: 'similar',
      originDetail: { from: params.appId, country: params.country },
      priority: PRIORITY.similar,
      depth: params.depth + 1,
    })),
  )
  return { discovered: appIds.length, enqueued }
}

export async function discoverFromPlayDeveloper(params: {
  devId: string
  country: string
  lang: string
  depth: number
}): Promise<DiscoveryResult> {
  if (params.depth >= MAX_TRAVERSAL_DEPTH) return { discovered: 0, enqueued: 0 }

  const items = await play.fetchDeveloperApps({
    devId: params.devId,
    country: params.country,
    lang: params.lang,
  })
  const appIds = items
    .map((item) => (typeof item.appId === 'string' ? item.appId : null))
    .filter((id): id is string => id !== null)

  const enqueued = await enqueueDiscovery(
    appIds.map((appId) => ({
      source: 'play' as const,
      sourceId: appId,
      origin: 'developer',
      originDetail: { devId: params.devId, country: params.country },
      priority: PRIORITY.developer,
      depth: params.depth + 1,
    })),
  )
  return { discovered: appIds.length, enqueued }
}

/** The long tail that never charts and nothing links to. */
export async function discoverFromPlaySearch(params: {
  term: string
  country: string
  lang: string
  num?: number
}): Promise<DiscoveryResult> {
  const items = await play.fetchSearch({
    term: params.term,
    num: params.num ?? 50,
    country: params.country,
    lang: params.lang,
  })
  const appIds = items
    .map((item) => (typeof item.appId === 'string' ? item.appId : null))
    .filter((id): id is string => id !== null)

  const enqueued = await enqueueDiscovery(
    appIds.map((appId) => ({
      source: 'play' as const,
      sourceId: appId,
      origin: 'search',
      originDetail: { term: params.term, country: params.country },
      priority: PRIORITY.search,
      depth: 0,
    })),
  )
  return { discovered: appIds.length, enqueued }
}

/** Apple's official charts. Same shape as Play's seeding, without the risk. */
export async function discoverFromAppleChart(params: {
  chart: ios.AppleChart
  country: string
  lang: string
  limit?: number
}): Promise<DiscoveryResult> {
  const ids = await ios.charts(params.chart, { country: params.country, limit: params.limit ?? 100 })

  await storeRaw({
    source: 'ios',
    kind: 'list',
    sourceId: params.chart,
    country: params.country,
    lang: params.lang,
    payload: ids,
  })

  const collection = params.chart === 'top-free' ? 'TOP_FREE' : 'TOP_PAID'
  const sourceIds = ids.map((id) => `id${id}`)

  await storeRanking({
    source: 'ios',
    collection,
    // Apple's marketing charts are overall, not per category. Recorded under the
    // canonical top-level id rather than invented per-category charts.
    categoryId: 'APPLICATION',
    country: params.country,
    lang: params.lang,
    sourceIds,
    ttlSeconds: config.TTL_RANKING,
  })

  const enqueued = await enqueueDiscovery(
    sourceIds.map((sourceId) => ({
      source: 'ios' as const,
      sourceId,
      origin: 'ranking',
      originDetail: { chart: params.chart, country: params.country },
      priority: PRIORITY.chart,
      depth: 0,
    })),
  )
  await markPopular('ios', sourceIds)
  return { discovered: sourceIds.length, enqueued }
}

export async function discoverFromAppleSearch(params: {
  term: string
  country: string
  lang: string
  limit?: number
}): Promise<DiscoveryResult> {
  const results = await ios.search(params.term, {
    country: params.country,
    lang: params.lang,
    limit: params.limit ?? 50,
  })
  const sourceIds = results.map((r) => `id${r.trackId}`)
  const enqueued = await enqueueDiscovery(
    sourceIds.map((sourceId) => ({
      source: 'ios' as const,
      sourceId,
      origin: 'search',
      originDetail: { term: params.term, country: params.country },
      priority: PRIORITY.search,
      depth: 0,
    })),
  )
  return { discovered: sourceIds.length, enqueued }
}

/**
 * Steam's most-played chart.
 *
 * Valve publishes no free / paid / grossing charts, so this is not dressed up as
 * one. It seeds the games that matter and is served under its own name.
 */
export async function discoverFromSteamMostPlayed(params: {
  country: string
  lang: string
}): Promise<DiscoveryResult> {
  const ranks = await steam.fetchMostPlayed()
  const sourceIds = ranks.map((r) => String(r.appid))

  await storeRaw({ source: 'steam', kind: 'list', sourceId: 'most_played', payload: ranks })
  await storeRanking({
    source: 'steam',
    collection: 'MOST_PLAYED',
    categoryId: 'GAME',
    country: params.country,
    lang: params.lang,
    sourceIds,
    ttlSeconds: config.TTL_RANKING,
  })

  const enqueued = await enqueueDiscovery(
    sourceIds.map((sourceId) => ({
      source: 'steam' as const,
      sourceId,
      origin: 'ranking',
      originDetail: { chart: 'most_played' },
      priority: PRIORITY.chart,
      depth: 0,
    })),
  )
  await markPopular('steam', sourceIds)
  return { discovered: sourceIds.length, enqueued }
}

/**
 * The full Steam catalogue.
 *
 * One call returns every appid Valve knows about, which is well over two hundred
 * thousand entries, most of them soundtracks, demos and dead prototypes. Taking
 * all of it would spend the entire ingest budget on things nobody searches for,
 * so this is capped and runs at the lowest priority, behind the charts.
 */
export async function discoverFromSteamCatalog(params: {
  limit?: number
}): Promise<DiscoveryResult> {
  const apps = await steam.fetchAppList()
  const limit = params.limit ?? 5000

  const usable = apps
    .filter((a) => a.name.trim().length > 0)
    // Bundled non-games are noise for a content site: they have no page worth
    // building. Filtered by name because appdetails is what would tell us the
    // type, and asking appdetails for 200k ids is the thing we are avoiding.
    .filter((a) => !/(soundtrack|demo|playtest|dedicated server|sdk|beta test)/i.test(a.name))
    .slice(0, limit)

  const enqueued = await enqueueDiscovery(
    usable.map((a) => ({
      source: 'steam' as const,
      sourceId: String(a.appid),
      origin: 'catalog',
      originDetail: { name: a.name },
      priority: PRIORITY.catalog,
      depth: 0,
    })),
  )

  logger.info('steam catalog scanned', {
    total: apps.length,
    considered: usable.length,
    enqueued,
    note: 'capped by limit; raise INGEST limits deliberately, not by accident',
  })
  return { discovered: usable.length, enqueued }
}
