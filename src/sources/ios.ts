/**
 * App Store source, via Apple's official iTunes Search API.
 *
 * This is a documented, public API, not scraping. It is preferred for every field
 * it covers, which is most of them. The gaps (per-star histogram, developer
 * contact details, the subtitle) are recorded in the coverage matrix rather than
 * filled by scraping Apple, because concentrating all the scraping risk in one
 * source was the point.
 *
 * One property of this API is worth exploiting deliberately: `lookup` accepts up
 * to 200 ids in a single call. Bulk refresh of the App Store corpus therefore
 * costs a fraction of what Google Play costs, so the ingest batches aggressively
 * here and conservatively there.
 */
import { z } from 'zod'
import { fetchJson } from '../lib/http.ts'
import { pacers } from '../lib/pacer.ts'
import { SourceError } from '../lib/source-errors.ts'

const BASE = 'https://itunes.apple.com'
/**
 * Canonical charts host. `rss.applemarketingtools.com` still works but answers a
 * 301 to this one, and paying for a redirect on every call is a waste.
 */
const CHARTS = 'https://rss.marketingtools.apple.com/api/v2'

/** Apple's genre id for Games. Anything under it is a game, not an app. */
export const APPLE_GAMES_GENRE_ID = '6014'

/** Hard limit imposed by Apple on a single lookup call. */
export const LOOKUP_BATCH_MAX = 200

const itunesResult = z
  .object({
    trackId: z.number(),
    trackName: z.string(),
    bundleId: z.string().optional(),
  })
  .passthrough()

const itunesResponse = z.object({
  resultCount: z.number(),
  results: z.array(z.unknown()),
})

export type ItunesApp = z.infer<typeof itunesResult> & Record<string, unknown>

const chartsResponse = z.object({
  feed: z.object({
    results: z.array(
      z
        .object({
          id: z.string(),
          name: z.string().optional(),
        })
        .passthrough(),
    ),
  }),
})

/** Apple expects `lang` as a locale like `es_es`, not a bare language code. */
export function appleLocale(lang: string, country: string): string {
  const base = lang.split('-')[0] ?? 'en'
  return `${base}_${country}`.toLowerCase()
}

async function paced<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const result = await pacers.ios.run(fn)
    pacers.ios.recordSuccess()
    return result
  } catch (error) {
    if (error instanceof SourceError) pacers.ios.recordFailure(error)
    throw error
  }
}

/**
 * Only the entries Apple returns that are actually apps get through. A lookup for
 * 200 ids where every single one fails to parse is a format change, not a batch
 * of dead apps, and it is reported as `malformed` rather than stored as nothing.
 */
function parseResults(raw: unknown[], context: Record<string, unknown>): ItunesApp[] {
  const apps: ItunesApp[] = []
  for (const entry of raw) {
    const parsed = itunesResult.safeParse(entry)
    if (parsed.success) apps.push(parsed.data as ItunesApp)
  }
  if (apps.length === 0 && raw.length > 0) {
    throw new SourceError('ios', 'malformed', 'No entry in the iTunes response looked like an app.', {
      detail: { ...context, received: raw.length },
    })
  }
  return apps
}

/**
 * Looks up between 1 and 200 App Store ids in one call.
 * Ids may be given bare (`1234567`) or in the `id1234567` form the client uses.
 */
export async function lookup(
  ids: string[],
  opts: { country: string; lang: string },
): Promise<ItunesApp[]> {
  if (ids.length === 0) return []
  if (ids.length > LOOKUP_BATCH_MAX) {
    throw new SourceError(
      'ios',
      'malformed',
      `lookup accepts at most ${LOOKUP_BATCH_MAX} ids per call, got ${ids.length}.`,
      { detail: { count: ids.length } },
    )
  }

  const numeric = ids.map((id) => id.replace(/^id/i, '')).filter((id) => /^\d+$/.test(id))
  if (numeric.length === 0) {
    throw new SourceError('ios', 'not_found', 'No usable App Store id in the request.', {
      detail: { ids: ids.slice(0, 5) },
    })
  }

  const url =
    `${BASE}/lookup?id=${numeric.join(',')}` +
    `&country=${encodeURIComponent(opts.country)}` +
    `&lang=${encodeURIComponent(appleLocale(opts.lang, opts.country))}` +
    `&entity=software`

  const body = await paced(() => fetchJson('ios', url, itunesResponse))
  return parseResults(body.results, { url })
}

export async function lookupOne(
  id: string,
  opts: { country: string; lang: string },
): Promise<ItunesApp> {
  const results = await lookup([id], opts)
  const first = results[0]
  if (!first) {
    throw new SourceError('ios', 'not_found', `App Store id ${id} not found in ${opts.country}.`, {
      detail: { id, country: opts.country },
    })
  }
  return first
}

/**
 * Apple's Search API.
 *
 * Measured 2026-07-26: Apple throttles this endpoint far harder than `/lookup`,
 * and it signals the throttle with **403 and an empty body, not 429**. A short
 * burst of requests produced 403 for every term, country and user agent while
 * `/lookup` on the same host kept answering 200; a few minutes later search was
 * answering 200 again. So the refusal is a soft, recoverable rate limit wearing
 * the status code of a hard block.
 *
 * Two consequences, both already handled:
 *  - our HTTP layer classifies 403 as `blocked`, which opens the circuit breaker
 *    with exponential backoff. That is the correct response to this behaviour.
 *  - nothing critical depends on search: cross-store matching runs against our
 *    own index first (services/matcher.ts) and the live search fallback degrades
 *    to local-only while the breaker is open.
 *
 * Treat search as an optimisation that may not be there. Treat `/lookup`, which
 * takes 200 ids per call, as the workhorse.
 */
export async function search(
  term: string,
  opts: { country: string; lang: string; limit?: number },
): Promise<ItunesApp[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 25))
  const url =
    `${BASE}/search?term=${encodeURIComponent(term)}` +
    `&country=${encodeURIComponent(opts.country)}` +
    `&lang=${encodeURIComponent(appleLocale(opts.lang, opts.country))}` +
    `&media=software&entity=software&limit=${limit}`

  const body = await paced(() => fetchJson('ios', url, itunesResponse))
  if (body.results.length === 0) return []
  return parseResults(body.results, { url })
}

export type AppleChart = 'top-free' | 'top-paid'

/**
 * Apple's official marketing charts.
 *
 * Only free and paid exist here. Apple publishes no public grossing chart, so
 * `/v1/top?sort=GROSSING&source=ios` is refused with an explanation rather than
 * answered with a substitute chart that would silently be a different thing.
 */
export async function charts(
  chart: AppleChart,
  opts: { country: string; limit?: number },
): Promise<string[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100))
  const url = `${CHARTS}/${encodeURIComponent(opts.country)}/apps/${chart}/${limit}/apps.json`
  const body = await paced(() => fetchJson('ios', url, chartsResponse))
  return body.feed.results.map((r) => r.id)
}

export function isGame(app: ItunesApp): boolean {
  const primary = app.primaryGenreId
  if (primary !== undefined && String(primary) === APPLE_GAMES_GENRE_ID) return true
  const genreIds = app.genreIds
  if (Array.isArray(genreIds) && genreIds.map(String).includes(APPLE_GAMES_GENRE_ID)) return true
  return String(app.primaryGenreName ?? '').toLowerCase() === 'games'
}
