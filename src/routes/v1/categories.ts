/**
 * GET /v1/categories
 *
 * Serves the client's 55 canonical categories verbatim: same ids, same slugs,
 * same names, same order. Nothing is derived from a library and nothing is
 * re-sorted. On the coupons project serving their list untouched was what they
 * asked for, so the same applies here.
 *
 * One entry, GAME_WORLD, has no counterpart in Google Play's taxonomy. It is
 * served because they asked for the list as given, and it is flagged with
 * `ingestable: false` so nobody wastes a request discovering that Play rejects it.
 */
import { Hono } from 'hono'
import { CATEGORIES, isIngestableOnPlay } from '../../data/categories.ts'
import { envelope } from '../../lib/envelope.ts'
import { resolveMarket } from '../../lib/request-context.ts'
import { resolveBool } from '../../lib/request-context.ts'

export const categoriesRoutes = new Hono()

categoriesRoutes.get('/categories', (c) => {
  const market = resolveMarket(c)
  const withFlags = resolveBool(c, 'with_flags', true)

  const items = CATEGORIES.map((category) =>
    withFlags
      ? {
          ...category,
          type: category.id.startsWith('GAME') ? 'game' : 'app',
          ingestable: isIngestableOnPlay(category.id),
        }
      : { ...category },
  )

  // Not paginated: it is a fixed reference list and consumers want all of it.
  return c.json(envelope(items, { total: items.length, market }))
})
