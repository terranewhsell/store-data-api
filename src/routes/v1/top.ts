/**
 * GET /v1/top?sort=TOP_PAID | TOP_FREE | GROSSING
 *
 * The three sort values are exactly the ones the client asked for, and they are
 * also the literal `collection` constants of google-play-scraper, which is why
 * Play is the default source.
 *
 * These are the pages that will carry the traffic, so two properties matter more
 * here than anywhere else:
 *
 *   - Stable order. Items come back in stored ranking position, never re-sorted.
 *     The same snapshot always renders identically.
 *   - Honest coverage. Apple publishes free and paid charts but no grossing
 *     chart, and Valve publishes none of the three. Those cases are refused with
 *     an explanation instead of answered with a different chart wearing the right
 *     name.
 */
import { Hono } from 'hono'
import { resolveCategory } from '../../data/categories.ts'
import { badRequest } from '../../lib/errors.ts'
import { paginatedEnvelope } from '../../lib/envelope.ts'
import { parsePageParams } from '../../lib/pagination.ts'
import { resolveMarket } from '../../lib/request-context.ts'
import type { Source } from '../../normalize/contract.ts'
import { getRanking } from '../../services/reads.ts'

/** The client's three, plus Steam's own chart under its own name. */
const COLLECTIONS = ['TOP_FREE', 'TOP_PAID', 'GROSSING', 'MOST_PLAYED'] as const
type Collection = (typeof COLLECTIONS)[number]

/** Which source can actually answer which chart. */
const SUPPORT: Record<Source, Collection[]> = {
  play: ['TOP_FREE', 'TOP_PAID', 'GROSSING'],
  ios: ['TOP_FREE', 'TOP_PAID'],
  steam: ['MOST_PLAYED'],
}

const UNSUPPORTED_REASON: Record<string, string> = {
  'ios:GROSSING':
    'Apple publishes no public grossing chart. Only TOP_FREE and TOP_PAID are available for source=ios.',
  'steam:TOP_FREE':
    'Valve publishes no free/paid/grossing charts. Use sort=MOST_PLAYED for the official Steam chart, or /v1/steam with sort_by.',
  'steam:TOP_PAID':
    'Valve publishes no free/paid/grossing charts. Use sort=MOST_PLAYED for the official Steam chart, or /v1/steam with sort_by.',
  'steam:GROSSING':
    'Valve publishes no free/paid/grossing charts. Use sort=MOST_PLAYED for the official Steam chart, or /v1/steam with sort_by.',
  'play:MOST_PLAYED': 'MOST_PLAYED is a Steam chart. Use source=steam.',
  'ios:MOST_PLAYED': 'MOST_PLAYED is a Steam chart. Use source=steam.',
}

export const topRoutes = new Hono()

topRoutes.get('/top', async (c) => {
  const market = resolveMarket(c)

  const rawSort = (c.req.query('sort') ?? 'TOP_FREE').trim().toUpperCase()
  if (!(COLLECTIONS as readonly string[]).includes(rawSort)) {
    throw badRequest(`Unknown sort "${rawSort}". Allowed: ${COLLECTIONS.join(', ')}.`, {
      allowed: [...COLLECTIONS],
    })
  }
  const collection = rawSort as Collection

  const rawSource = (c.req.query('source') ?? 'play').trim().toLowerCase()
  if (rawSource !== 'play' && rawSource !== 'ios' && rawSource !== 'steam') {
    throw badRequest(`Unknown source "${rawSource}". Allowed: play, ios, steam.`)
  }
  const source = rawSource as Source

  if (!SUPPORT[source].includes(collection)) {
    throw badRequest(
      UNSUPPORTED_REASON[`${source}:${collection}`] ??
        `source=${source} does not publish a ${collection} chart.`,
      { source, sort: collection, supported: SUPPORT[source] },
    )
  }

  // Category is the canonical id or slug. Apple's charts are overall rather than
  // per category, and are stored under APPLICATION for that reason.
  const rawCategory = c.req.query('category')?.trim()
  let categoryId = source === 'ios' ? 'APPLICATION' : source === 'steam' ? 'GAME' : 'APPLICATION'

  if (rawCategory) {
    const category = resolveCategory(rawCategory)
    if (!category) {
      throw badRequest(
        `Unknown category "${rawCategory}". See /v1/categories for the canonical list.`,
      )
    }
    if (source === 'play') {
      categoryId = category.id
    } else if (category.id !== categoryId) {
      throw badRequest(
        `source=${source} publishes only an overall chart, not per-category ones. Drop the category parameter.`,
        { source },
      )
    }
  }

  const { page, perPage, offset } = parsePageParams(
    { page: c.req.query('page'), per_page: c.req.query('per_page') },
    { defaultPerPage: 50 },
  )

  const ranking = await getRanking({
    source,
    collection,
    categoryId,
    country: market.country,
    lang: market.lang,
    offset,
    limit: perPage,
  })

  const body = paginatedEnvelope(ranking.items, {
    total: ranking.total,
    page,
    perPage,
    market,
  })

  return c.json({
    ...body,
    source,
    sort: collection,
    category: categoryId,
    /**
     * `total` is the size of the chart; `items_ingested` is how many of those
     * listings we actually hold.
     *
     * They differ on a fresh catalogue, and without saying so the response looks
     * broken: a chart of twenty with an empty page reads as a failure rather
     * than as "we know about these twenty apps and have not fetched them yet".
     * Reporting the joined count as `total` instead would be worse, because it
     * would claim the chart is smaller than it is.
     */
    items_ingested: ranking.ingested,
    // The freshness of the chart itself, separate from the freshness of the
    // listings in it. A consumer building a page needs both.
    captured_at: ranking.capturedAt,
    expires_at: ranking.expiresAt,
    age_seconds: ranking.ageSeconds,
    stale: ranking.stale,
  })
})
