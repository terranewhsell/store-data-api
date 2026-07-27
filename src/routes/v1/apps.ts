/**
 * GET /v1/apps          Google Play and App Store listings.
 * GET /v1/apps/:slug    One listing, by its permanent slug.
 *
 * One record is one (source, native id) pair. Play and App Store listings are not
 * merged into a single row: title, description, price and score genuinely differ
 * between the stores, and folding them together would destroy information while
 * looking tidier. The link between them is `iosId`, with its confidence in
 * `_meta.iosMatch`.
 */
import { Hono } from 'hono'
import { notFound } from '../../lib/errors.ts'
import { paginatedEnvelope } from '../../lib/envelope.ts'
import { parsePageParams } from '../../lib/pagination.ts'
import {
  resolveBool,
  resolveMarket,
  resolveSort,
  resolveSources,
  resolveType,
} from '../../lib/request-context.ts'
import type { Source } from '../../normalize/contract.ts'
import { getApp, listApps } from '../../services/reads.ts'

/** `/v1/apps` covers the two mobile stores; Steam has its own route. */
const MOBILE_SOURCES: readonly Source[] = ['play', 'ios']

export const appsRoutes = new Hono()

appsRoutes.get('/apps', async (c) => {
  const market = resolveMarket(c)
  const requested = resolveSources(c, MOBILE_SOURCES)
  const { sort, order } = resolveSort(c)
  const { page, perPage, offset } = parsePageParams({
    page: c.req.query('page'),
    per_page: c.req.query('per_page'),
  })

  const type = resolveType(c)
  const genreId = c.req.query('genre_id')?.trim()
  const developerId = c.req.query('developer_id')?.trim()

  const result = await listApps(
    {
      // An empty filter still means "the two mobile stores", never Steam.
      sources: requested.length > 0 ? requested : [...MOBILE_SOURCES],
      country: market.country,
      lang: market.lang,
      ...(type ? { type } : {}),
      ...(genreId ? { genreId } : {}),
      ...(developerId ? { developerId } : {}),
      includeDelisted: resolveBool(c, 'include_delisted', false),
      sort,
      order,
    },
    { offset, limit: perPage },
  )

  const body = paginatedEnvelope(result.items, {
    total: result.total,
    page,
    perPage,
    market,
  })

  return c.json({
    ...body,
    ...(result.marketFallback ? { served_market: result.servedMarket, market_fallback: true } : {}),
  })
})

appsRoutes.get('/apps/:slug', async (c) => {
  const market = resolveMarket(c)
  const slug = c.req.param('slug')

  const app = await getApp({ slug }, market)
  if (!app) throw notFound(`No app with slug "${slug}".`)
  if (app._meta.source === 'steam') throw notFound(`"${slug}" is a Steam title. Use /v1/steam/${slug}.`)

  return c.json(app)
})

/**
 * Lookup by native store id, for callers holding a package name or an iTunes id
 * rather than our slug.
 */
appsRoutes.get('/apps/:source/:sourceId', async (c) => {
  const market = resolveMarket(c)
  const source = c.req.param('source') as Source
  const sourceId = c.req.param('sourceId')

  if (!MOBILE_SOURCES.includes(source)) {
    throw notFound(`Unknown source "${source}" on this route. Use play or ios.`)
  }

  const app = await getApp({ source, sourceId }, market)
  if (!app) throw notFound(`No ${source} app with id "${sourceId}".`)
  return c.json(app)
})
