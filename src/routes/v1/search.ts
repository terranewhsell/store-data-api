/**
 * GET /v1/search?q=...
 *
 * Searches our own Postgres index. It does NOT query Google Play: a live request
 * to Play on every user search is the fastest way to get the IP banned, and the
 * brief rules it out explicitly.
 *
 * When the local index has nothing, a live fallback against App Store and Steam
 * may run. Both are official public APIs. The fallback is rate limited per
 * caller, bounded by a short deadline, and everything it finds is queued for
 * proper ingestion so the second identical search is served locally.
 */
import { Hono } from 'hono'
import { config } from '../../config.ts'
import { badRequest, rateLimited } from '../../lib/errors.ts'
import { paginatedEnvelope } from '../../lib/envelope.ts'
import { parsePageParams } from '../../lib/pagination.ts'
import { callerKey, SlidingWindowLimiter } from '../../lib/rate-limit.ts'
import { resolveBool, resolveMarket, resolveSources, resolveType } from '../../lib/request-context.ts'
import { search } from '../../services/search.ts'

/**
 * Guards the only path that can reach outside. Keyed by token when present, by
 * IP otherwise, so one token cannot hide behind a shared address.
 */
const liveLimiter = new SlidingWindowLimiter(config.LIVE_SEARCH_RATE_LIMIT_PER_MIN, 60_000)

export const searchRoutes = new Hono()

searchRoutes.get('/search', async (c) => {
  const term = (c.req.query('q') ?? c.req.query('term') ?? '').trim()
  if (term.length === 0) {
    throw badRequest('A search term is required: /v1/search?q=your+term')
  }
  if (term.length > 200) {
    throw badRequest('Search term is too long (200 characters maximum).')
  }

  const market = resolveMarket(c)
  const sources = resolveSources(c)
  const type = resolveType(c)
  const { page, perPage, offset } = parsePageParams({
    page: c.req.query('page'),
    per_page: c.req.query('per_page'),
  })

  // The caller can opt out of the live fallback to guarantee a fast answer.
  const wantsLive = resolveBool(c, 'live', true)
  let allowLive = wantsLive && config.LIVE_SEARCH_ENABLED

  if (allowLive) {
    const key = callerKey({
      authorization: c.req.header('authorization'),
      forwardedFor: c.req.header('x-forwarded-for'),
      remoteAddress: c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip'),
    })
    const verdict = liveLimiter.check(key)
    if (!verdict.allowed) {
      // Over the limit for the OUTBOUND part only. A local search is cheap and
      // still answered; only the fallback is withheld.
      if (c.req.query('live') === '1' || c.req.query('live') === 'true') {
        throw rateLimited(verdict.retryAfterSeconds)
      }
      allowLive = false
    }
  }

  const result = await search({
    term,
    country: market.country,
    lang: market.lang,
    sources,
    ...(type ? { type } : {}),
    offset,
    limit: perPage,
    allowLive,
  })

  const body = paginatedEnvelope(result.items, {
    total: result.total,
    page,
    perPage,
    market,
  })

  return c.json({
    ...body,
    query: term,
    live_fallback_used: result.liveFallbackUsed,
    // Honest signal: the term found nothing locally, we have queued the ids we
    // could see, and a later identical search will have them.
    queued_for_ingest: result.queuedForIngest,
  })
})
