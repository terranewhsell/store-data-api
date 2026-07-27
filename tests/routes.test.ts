/**
 * End-to-end, against a real embedded Postgres.
 *
 * Migrations run, fixtures are ingested through the same repository the worker
 * uses, and the routes are exercised through the actual Hono app. No source is
 * contacted: the fixtures stand in for the network, everything after that is the
 * real code path.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app.ts'
import { getDb } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { normalizeIosApp } from '../src/normalize/ios.ts'
import { normalizePlayApp } from '../src/normalize/play.ts'
import { normalizeSteamApp } from '../src/normalize/steam.ts'
import { storeLocale, storeRanking, storeRaw, upsertApp } from '../src/services/repository.ts'
import { renormalize } from '../src/services/ingest.ts'
import {
  ITUNES_GAME,
  ITUNES_TRANSLATE,
  PLAY_FAMILY_APP,
  PLAY_FAMILY_GAME,
  PLAY_GAME,
  PLAY_TRANSLATE,
  STEAM_PAID,
  STEAM_REVIEWS,
  STEAM_TF2,
} from './fixtures.ts'

const TOKEN = process.env.API_BEARER_TOKEN as string
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: Hono

async function seed(normalized: ReturnType<typeof normalizePlayApp>): Promise<string> {
  const record = await upsertApp({
    source: normalized.source,
    sourceId: normalized.sourceId,
    title: normalized.core.title ?? normalized.sourceId,
    type: normalized.core.type,
    genreId: normalized.core.genreId,
    developerId: normalized.core.developerId,
    isPopular: true,
  })
  await storeLocale(record, normalized, 86_400)
  return record.slug
}

beforeAll(async () => {
  await runMigrations(getDb())
  app = createApp()

  const market = { country: 'us', lang: 'en' }
  await seed(normalizePlayApp(PLAY_TRANSLATE, market))
  await seed(normalizePlayApp(PLAY_GAME, market))
  await seed(normalizePlayApp(PLAY_FAMILY_GAME, market))
  await seed(normalizePlayApp(PLAY_FAMILY_APP, market))
  await seed(normalizeIosApp(ITUNES_TRANSLATE as never, market))
  await seed(normalizeIosApp(ITUNES_GAME as never, market))
  await seed(normalizeSteamApp(STEAM_TF2 as never, { ...market, reviews: STEAM_REVIEWS }))
  await seed(normalizeSteamApp(STEAM_PAID as never, { ...market, reviews: STEAM_REVIEWS }))

  await storeRanking({
    source: 'play',
    collection: 'TOP_FREE',
    categoryId: 'APPLICATION',
    country: 'us',
    lang: 'en',
    sourceIds: ['com.google.android.apps.translate', 'com.supercell.clashofclans'],
    ttlSeconds: 21_600,
  })
})

async function get(path: string, headers: Record<string, string> = AUTH): Promise<Response> {
  return app.request(`http://localhost${path}`, { headers })
}

/** The routes return JSON; the assertions below check its shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json()
}

describe('authentication', () => {
  test('401 with the WP_Error body when no token is presented', async () => {
    const res = await get('/v1/categories', {})
    expect(res.status).toBe(401)

    const body = await json(res)
    expect(body).toEqual({
      code: 'store_unauthorized',
      message: 'Unauthorized: Authorization: Bearer <token> is required.',
      data: { status: 401 },
    })
  })

  test('401 for a wrong token', async () => {
    const res = await get('/v1/categories', { authorization: 'Bearer wrong' })
    expect(res.status).toBe(401)
    expect((await json(res)).code).toBe('store_unauthorized')
  })

  test('401 for a non-Bearer scheme', async () => {
    const res = await get('/v1/categories', { authorization: `Basic ${TOKEN}` })
    expect(res.status).toBe(401)
  })

  test('the fallback header works when the proxy strips Authorization', async () => {
    const res = await get('/v1/categories', { 'x-authorization': `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
  })

  test('/health needs no token', async () => {
    const res = await get('/health', {})
    expect(res.status).toBe(200)
    expect((await json(res)).status).toBe('ok')
  })

  test('every response carries the version and noindex headers', async () => {
    const res = await get('/v1/categories')
    expect(res.headers.get('X-API-Version')).toBe('v1')
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })
})

describe('GET /v1/categories', () => {
  test('serves the 55 canonical entries in order', async () => {
    const body = await json(await get('/v1/categories'))
    expect(body.total).toBe(55)
    expect(body.items).toHaveLength(55)
    expect(body.items[0].id).toBe('APPLICATION')
    expect(body.items[54].id).toBe('GAME_WORLD')
  })

  test('is not paginated: it is a fixed reference list', async () => {
    const body = await json(await get('/v1/categories'))
    expect(body).not.toHaveProperty('pages')
    expect(body).not.toHaveProperty('per_page')
    expect(Object.keys(body)).toEqual([
      'version', 'generated_at', 'lang', 'country', 'total', 'items',
    ])
  })

  test('flags the entry Google Play does not know about', async () => {
    const body = await json(await get('/v1/categories'))
    const gameWorld = body.items.find((c: { id: string }) => c.id === 'GAME_WORLD')
    expect(gameWorld.ingestable).toBe(false)
    expect(body.items.find((c: { id: string }) => c.id === 'TOOLS').ingestable).toBe(true)
  })
})

describe('GET /v1/apps', () => {
  test('returns the coupons envelope plus country', async () => {
    const body = await json(await get('/v1/apps?per_page=2'))
    expect(Object.keys(body)).toEqual([
      'version', 'generated_at', 'lang', 'country', 'total', 'pages', 'page',
      'per_page', 'items',
    ])
    expect(body.country).toBe('us')
    expect(body.lang).toBe('en')
    expect(body.per_page).toBe(2)
  })

  test('covers Play and App Store but never Steam', async () => {
    const body = await json(await get('/v1/apps?per_page=200'))
    const sources = new Set(body.items.map((i: { _meta: { source: string } }) => i._meta.source))
    expect(sources.has('play')).toBe(true)
    expect(sources.has('ios')).toBe(true)
    expect(sources.has('steam')).toBe(false)
  })

  test('per_page is clamped to 200', async () => {
    const body = await json(await get('/v1/apps?per_page=99999'))
    expect(body.per_page).toBe(200)
  })

  test('filters by source and by type', async () => {
    const play = await json(await get('/v1/apps?source=play&per_page=200'))
    expect(
      play.items.every((i: { _meta: { source: string } }) => i._meta.source === 'play'),
    ).toBe(true)

    const games = await json(await get('/v1/apps?type=game&per_page=200'))
    expect(games.items.every((i: { type: string }) => i.type === 'game')).toBe(true)
    expect(games.items.length).toBeGreaterThan(0)
  })

  test('rejects an unknown source with a clear 400', async () => {
    const res = await get('/v1/apps?source=nintendo')
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.code).toBe('store_bad_request')
    expect(body.data.status).toBe(400)
  })

  test('every item carries a permanent slug', async () => {
    const body = await json(await get('/v1/apps?per_page=200'))
    for (const item of body.items) {
      expect(typeof item.slug).toBe('string')
      expect(item.slug.length).toBeGreaterThan(1)
    }
  })
})

describe('GET /v1/apps/:slug', () => {
  test('returns the full contract with every canonical key', async () => {
    const list = await json(await get('/v1/apps?source=play&per_page=1'))
    const slug = list.items[0].slug

    const app_ = await json(await get(`/v1/apps/${slug}`))
    for (const field of ['title', 'description', 'descriptionHTML', 'histogram',
      'IAPRange', 'developerLegalName', 'editorsChoice', 'features', 'appId',
      'iosId', 'url', 'type']) {
      expect(Object.hasOwn(app_, field), `missing ${field}`).toBe(true)
    }
    expect(app_).toHaveProperty('slug')
    expect(app_).toHaveProperty('extra')
    expect(app_).toHaveProperty('_meta')
  })

  test('_meta explains freshness, source and every null', async () => {
    const app_ = await json(await get('/v1/apps/google-translate'))
    expect(app_._meta.source).toBe('play')
    expect(app_._meta.sourceId).toBe('com.google.android.apps.translate')
    expect(app_._meta.market).toEqual({ country: 'us', lang: 'en' })
    expect(typeof app_._meta.ageSeconds).toBe('number')
    expect(app_._meta.status).toBe('active')
    expect(app_._meta.fieldCoverage.editorsChoice).toBe('not_available')
  })

  test('404 for an unknown slug', async () => {
    const res = await get('/v1/apps/there-is-no-such-app')
    expect(res.status).toBe(404)
    expect((await json(res)).code).toBe('store_not_found')
  })

  test('a Steam title is redirected to its own route rather than served here', async () => {
    const res = await get('/v1/apps/team-fortress-2')
    expect(res.status).toBe(404)
    expect((await json(res)).message).toContain('/v1/steam/')
  })

  test('lookup by native store id works too', async () => {
    const res = await get('/v1/apps/play/com.google.android.apps.translate')
    expect(res.status).toBe(200)
    expect((await json(res)).appId).toBe('com.google.android.apps.translate')
  })
})

describe('GET /v1/steam', () => {
  test('lists only Steam titles', async () => {
    const body = await json(await get('/v1/steam?per_page=200'))
    expect(body.items.length).toBeGreaterThan(0)
    expect(
      body.items.every((i: { _meta: { source: string } }) => i._meta.source === 'steam'),
    ).toBe(true)
  })

  test('a Steam title uses the same contract, with its own coverage', async () => {
    const body = await json(await get('/v1/steam/440'))
    expect(body.title).toBe('Team Fortress 2')
    expect(body.histogram).toBeNull()
    expect(body._meta.fieldCoverage.histogram).toBe('not_available')
    expect(body._meta.fieldCoverage.androidVersion).toBe('not_applicable')
    expect(body._meta.derivedFields.score).toContain('total_positive')
    expect(body.extra.steam.metacritic.score).toBe(92)
  })

  test('a Play app is not served from the Steam route', async () => {
    const res = await get('/v1/steam/google-translate')
    expect(res.status).toBe(404)
    expect((await json(res)).message).toContain('/v1/apps/')
  })
})

describe('GET /v1/top', () => {
  test('serves the ranking in stored position order', async () => {
    const body = await json(await get('/v1/top?sort=TOP_FREE'))
    expect(body.sort).toBe('TOP_FREE')
    expect(body.source).toBe('play')
    expect(body.items[0].appId).toBe('com.google.android.apps.translate')
    expect(body.items[1].appId).toBe('com.supercell.clashofclans')
    expect(body.total).toBe(2)
  })

  test('the same request twice returns the same order', async () => {
    const first = await json(await get('/v1/top?sort=TOP_FREE'))
    const second = await json(await get('/v1/top?sort=TOP_FREE'))
    expect(first.items.map((i: { slug: string }) => i.slug)).toEqual(
      second.items.map((i: { slug: string }) => i.slug),
    )
  })

  test('reports the age of the chart separately from the listings', async () => {
    const body = await json(await get('/v1/top?sort=TOP_FREE'))
    expect(typeof body.captured_at).toBe('string')
    expect(typeof body.age_seconds).toBe('number')
    expect(body.stale).toBe(false)
  })

  test('accepts all three sorts the client asked for', async () => {
    for (const sort of ['TOP_FREE', 'TOP_PAID', 'GROSSING']) {
      const res = await get(`/v1/top?sort=${sort}`)
      expect(res.status).toBe(200)
    }
  })

  test('refuses a chart Apple does not publish, and explains why', async () => {
    const res = await get('/v1/top?sort=GROSSING&source=ios')
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.message).toContain('no public grossing chart')
  })

  test('refuses Steam free/paid charts and points at the real one', async () => {
    const res = await get('/v1/top?sort=TOP_PAID&source=steam')
    expect(res.status).toBe(400)
    expect((await json(res)).message).toContain('MOST_PLAYED')
  })

  test('rejects an unknown sort', async () => {
    const res = await get('/v1/top?sort=TOP_SOMETHING')
    expect(res.status).toBe(400)
  })

  test('rejects an unknown category', async () => {
    const res = await get('/v1/top?sort=TOP_FREE&category=NOT_A_CATEGORY')
    expect(res.status).toBe(400)
    expect((await json(res)).message).toContain('/v1/categories')
  })
})

describe('GET /v1/search', () => {
  test('finds by title from the local index', async () => {
    const body = await json(await get('/v1/search?q=translate'))
    expect(body.total).toBeGreaterThan(0)
    expect(body.query).toBe('translate')
    expect(
      body.items.some((i: { title: string }) => i.title === 'Google Translate'),
    ).toBe(true)
  })

  test('finds by words in the description, not just the title', async () => {
    const body = await json(await get('/v1/search?q=tactical'))
    expect(body.total).toBeGreaterThan(0)
  })

  test('an exact title match ranks first', async () => {
    const body = await json(await get('/v1/search?q=Clash of Clans'))
    expect(body.items[0].title).toBe('Clash of Clans')
  })

  test('a prefix finds the app', async () => {
    const body = await json(await get('/v1/search?q=goog'))
    expect(body.total).toBeGreaterThan(0)
  })

  test('never reaches Google Play, so an unknown term simply returns empty', async () => {
    const body = await json(await get('/v1/search?q=zzzzzznotanapp'))
    expect(body.total).toBe(0)
    expect(body.items).toEqual([])
    // Live fallback is disabled in tests; with it on, only ios and steam apply.
    expect(body.live_fallback_used).toBe(false)
  })

  test('requires a term', async () => {
    const res = await get('/v1/search')
    expect(res.status).toBe(400)
    expect((await json(res)).message).toContain('search term is required')
  })

  test('filters by source and type', async () => {
    const body = await json(await get('/v1/search?q=translate&source=ios'))
    expect(
      body.items.every((i: { _meta: { source: string } }) => i._meta.source === 'ios'),
    ).toBe(true)
  })
})

describe('GET /v1/export/apps', () => {
  test('returns a cursor rather than page numbers', async () => {
    const body = await json(await get('/v1/export/apps?limit=2'))
    expect(body.items).toHaveLength(2)
    expect(body.has_more).toBe(true)
    expect(typeof body.next_cursor).toBe('string')
  })

  test('the cursor walks the whole set exactly once', async () => {
    const seen: string[] = []
    let cursor: string | null = null

    for (let i = 0; i < 20; i++) {
      const url: string = `/v1/export/apps?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await json(await get(url))
      for (const item of body.items) seen.push(item.slug)
      cursor = body.next_cursor
      if (!body.has_more) break
    }

    expect(seen).toHaveLength(new Set(seen).size)
    expect(seen.length).toBe(8)
  })

  test('items carry the full contract, for building a page from', async () => {
    const body = await json(await get('/v1/export/apps?limit=1'))
    const item = body.items[0]
    expect(item).toHaveProperty('descriptionHTML')
    expect(item).toHaveProperty('screenshots')
    expect(item).toHaveProperty('slug')
    expect(item).toHaveProperty('_meta')
  })

  test('since filters by real content change, not by refresh time', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const body = await json(await get(`/v1/export/apps?since=${future}`))
    expect(body.items).toHaveLength(0)
  })

  test('rejects a malformed cursor instead of returning the wrong page', async () => {
    const res = await get('/v1/export/apps?cursor=not-a-cursor')
    expect(res.status).toBe(400)
  })

  test('rejects a malformed since', async () => {
    const res = await get('/v1/export/apps?since=yesterday')
    expect(res.status).toBe(400)
  })
})

describe('GET /v1/status', () => {
  test('reports per-source counts, freshness and breaker state', async () => {
    const body = await json(await get('/v1/status'))
    expect(body.sources).toHaveLength(3)

    const play = body.sources.find((s: { source: string }) => s.source === 'play')
    expect(play.apps).toBeGreaterThan(0)
    expect(play.listings).toBeGreaterThan(0)
    expect(typeof play.oldestAgeSeconds).toBe('number')
    expect(play.breaker.state).toBe('ok')
  })

  test('reports queue depth and whether anything is moving', async () => {
    const body = await json(await get('/v1/status'))
    expect(body.queue).toHaveProperty('ingest')
    expect(body.queue).toHaveProperty('discovery')
    expect(typeof body.queue.movingLastHour).toBe('number')
    expect(Array.isArray(body.warnings)).toBe(true)
  })

  test('is behind the token, like everything else', async () => {
    expect((await get('/v1/status', {})).status).toBe(401)
  })
})

describe('type derivation', () => {
  test('a GAME_ genre is a game', async () => {
    const body = await json(await get('/v1/apps/clash-of-clans'))
    expect(body.type).toBe('game')
  })

  test('FAMILY with a game sub-category is a game', async () => {
    const body = await json(await get('/v1/apps/toca-kitchen'))
    expect(body.type).toBe('game')
  })

  test('FAMILY without one is an app', async () => {
    const body = await json(await get('/v1/apps/family-organiser'))
    expect(body.type).toBe('app')
  })

  test('a Steam title is a game', async () => {
    const body = await json(await get('/v1/steam/440'))
    expect(body.type).toBe('game')
  })
})

describe('reprocessing from stored raw payloads', () => {
  /**
   * Regression. Steam's review summary comes from a different endpoint and is
   * stored as its own raw payload. A reprocess that only read the `app` payloads
   * rebuilt every Steam record without `score`, `scoreText` or `ratings`, and did
   * it silently: the rows were still there, still valid, just quietly worse.
   *
   * Caught in production data, not in a test, which is exactly why this exists.
   */
  test('a Steam reprocess keeps the review-derived fields', async () => {
    const market = { country: 'us', lang: 'en' }

    await storeRaw({
      source: 'steam',
      kind: 'app',
      sourceId: '440',
      country: market.country,
      lang: market.lang,
      payload: STEAM_TF2,
    })
    await storeRaw({
      source: 'steam',
      kind: 'reviews',
      sourceId: '440',
      payload: STEAM_REVIEWS,
    })

    const before = await json(await get('/v1/steam/440'))
    expect(before.score).toBe(4.5)

    const result = await renormalize({ source: 'steam', limit: 50 })
    expect(result.failed).toBe(0)

    const after = await json(await get('/v1/steam/440'))
    expect(after.score).toBe(4.5)
    expect(after.scoreText).toBe('4.5')
    expect(after.ratings).toBe(1000)
    expect(after._meta.derivedFields.score).toContain('total_positive')
    // Still not invented, even on the way back.
    expect(after.histogram).toBeNull()
  })
})

describe('unknown routes', () => {
  test('404 in the same error shape as everything else', async () => {
    const res = await get('/v1/nope')
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(body.code).toBe('store_not_found')
    expect(body.data.status).toBe(404)
  })
})
