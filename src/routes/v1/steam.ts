/**
 * GET /v1/steam        Steam titles.
 * GET /v1/steam/:slug  One title.
 *
 * Same contract as /v1/apps: identical field names, every key present. The fields
 * Steam has no equivalent for are null and explained in `_meta.fieldCoverage`, and
 * the fields Steam has that the contract does not carry (Metacritic, platforms,
 * DLC, achievements) are under `extra.steam` rather than discarded.
 *
 * `score` for a Steam title is derived, not reported: Valve publishes a
 * positive/negative split, not a star average. The formula is in
 * `_meta.derivedFields` and the untouched numbers are in `extra.steam`.
 * `histogram` is null, because there is no per-star data to build it from and
 * inventing one would be indistinguishable from the real thing.
 */
import { Hono } from 'hono'
import { notFound } from '../../lib/errors.ts'
import { paginatedEnvelope } from '../../lib/envelope.ts'
import { parsePageParams } from '../../lib/pagination.ts'
import { resolveBool, resolveMarket, resolveSort, resolveType } from '../../lib/request-context.ts'
import { getApp, listApps } from '../../services/reads.ts'

export const steamRoutes = new Hono()

steamRoutes.get('/steam', async (c) => {
  const market = resolveMarket(c)
  const { sort, order } = resolveSort(c)
  const { page, perPage, offset } = parsePageParams({
    page: c.req.query('page'),
    per_page: c.req.query('per_page'),
  })

  const type = resolveType(c)
  const genreId = c.req.query('genre_id')?.trim()

  const result = await listApps(
    {
      sources: ['steam'],
      country: market.country,
      lang: market.lang,
      ...(type ? { type } : {}),
      ...(genreId ? { genreId } : {}),
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

steamRoutes.get('/steam/:slug', async (c) => {
  const market = resolveMarket(c)
  const slug = c.req.param('slug')

  // Numeric segments are Steam appids, which is what most callers will have.
  const app = /^\d+$/.test(slug)
    ? await getApp({ source: 'steam', sourceId: slug }, market)
    : await getApp({ slug }, market)

  if (!app) throw notFound(`No Steam title with identifier "${slug}".`)
  if (app._meta.source !== 'steam') {
    throw notFound(`"${slug}" is not a Steam title. Use /v1/apps/${slug}.`)
  }
  return c.json(app)
})
