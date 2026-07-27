/**
 * Steam source, via Valve's public store endpoints.
 *
 * No scraping. `appdetails` and `appreviews` are the endpoints the whole industry
 * uses; `ISteamApps/GetAppList` and `ISteamChartsService/GetMostPlayedGames` are
 * documented Web API methods that need no key.
 *
 * Honest caveat, and it belongs in the client conversation: `appdetails` is
 * public and universally used but Valve does not formally document it. Its shape
 * is validated on every call for exactly that reason, so a change surfaces as a
 * loud `malformed` error instead of a table full of nulls.
 */
import { z } from 'zod'
import { fetchJson } from '../lib/http.ts'
import { pacers } from '../lib/pacer.ts'
import { SourceError } from '../lib/source-errors.ts'

const STORE = 'https://store.steampowered.com'
const API = 'https://api.steampowered.com'

/** Steam takes a language NAME, not a code. Unknown codes fall back to english. */
const STEAM_LANGUAGES: Record<string, string> = {
  en: 'english',
  es: 'spanish',
  pt: 'brazilian',
  de: 'german',
  fr: 'french',
  it: 'italian',
  ja: 'japanese',
  ko: 'koreana',
  zh: 'schinese',
  ru: 'russian',
  pl: 'polish',
  nl: 'dutch',
  tr: 'turkish',
  sv: 'swedish',
  da: 'danish',
  no: 'norwegian',
  fi: 'finnish',
  cs: 'czech',
  hu: 'hungarian',
  el: 'greek',
  th: 'thai',
  vi: 'vietnamese',
  uk: 'ukrainian',
  ro: 'romanian',
  bg: 'bulgarian',
  ar: 'arabic',
}

export function steamLanguage(lang: string): string {
  const base = (lang.split('-')[0] ?? 'en').toLowerCase()
  return STEAM_LANGUAGES[base] ?? 'english'
}

const appDetailsData = z
  .object({
    type: z.string().optional(),
    name: z.string().min(1),
    steam_appid: z.number(),
  })
  .passthrough()

const appDetailsEnvelope = z.record(
  z.string(),
  z.object({
    success: z.boolean(),
    data: z.unknown().optional(),
  }),
)

const reviewSummary = z.object({
  success: z.number(),
  query_summary: z
    .object({
      review_score: z.number().optional(),
      review_score_desc: z.string().optional(),
      total_positive: z.number().optional(),
      total_negative: z.number().optional(),
      total_reviews: z.number().optional(),
    })
    .optional(),
})

const appListResponse = z.object({
  applist: z.object({
    apps: z.array(z.object({ appid: z.number(), name: z.string() })),
  }),
})

const mostPlayedResponse = z.object({
  response: z.object({
    ranks: z.array(
      z
        .object({
          rank: z.number(),
          appid: z.number(),
        })
        .passthrough(),
    ),
  }),
})

export type SteamAppDetails = z.infer<typeof appDetailsData> & Record<string, unknown>

export interface SteamReviewSummary {
  reviewScore: number | null
  reviewScoreDesc: string | null
  totalPositive: number | null
  totalNegative: number | null
  totalReviews: number | null
}

async function paced<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const result = await pacers.steam.run(fn)
    pacers.steam.recordSuccess()
    return result
  } catch (error) {
    if (error instanceof SourceError) pacers.steam.recordFailure(error)
    throw error
  }
}

/**
 * One store listing.
 *
 * `appdetails` accepts several appids but only returns full data for the first,
 * so this is deliberately one at a time. Batching here would look like a saving
 * and quietly return empty records for everything after the first id.
 */
export async function fetchAppDetails(
  appId: string,
  opts: { country: string; lang: string },
): Promise<SteamAppDetails> {
  const url =
    `${STORE}/api/appdetails?appids=${encodeURIComponent(appId)}` +
    `&cc=${encodeURIComponent(opts.country)}` +
    `&l=${encodeURIComponent(steamLanguage(opts.lang))}`

  const body = await paced(() => fetchJson('steam', url, appDetailsEnvelope))
  const entry = body[appId]

  if (!entry) {
    throw new SourceError('steam', 'malformed', `Steam response had no entry for appid ${appId}.`, {
      detail: { url, keys: Object.keys(body).slice(0, 5) },
    })
  }
  // `success: false` is Steam's way of saying the app is region-locked, delisted
  // or never existed. It is a legitimate answer, not a failure of ours.
  if (!entry.success || entry.data === undefined) {
    throw new SourceError(
      'steam',
      'not_found',
      `Steam appid ${appId} is not available in ${opts.country}.`,
      { detail: { appId, country: opts.country } },
    )
  }

  const parsed = appDetailsData.safeParse(entry.data)
  if (!parsed.success) {
    throw new SourceError(
      'steam',
      'malformed',
      'Steam appdetails payload did not match the expected shape. Refusing to store it.',
      {
        detail: {
          appId,
          issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')),
        },
      },
    )
  }
  return parsed.data as SteamAppDetails
}

/**
 * Review totals. Steam gives a positive/negative split and a 0-10 score; it does
 * not give a per-star breakdown, which is why `histogram` stays null downstream.
 */
export async function fetchReviewSummary(appId: string): Promise<SteamReviewSummary> {
  const url =
    `${STORE}/appreviews/${encodeURIComponent(appId)}` +
    `?json=1&language=all&purchase_type=all&num_per_page=0`

  const body = await paced(() => fetchJson('steam', url, reviewSummary))
  const s = body.query_summary
  return {
    reviewScore: s?.review_score ?? null,
    reviewScoreDesc: s?.review_score_desc ?? null,
    totalPositive: s?.total_positive ?? null,
    totalNegative: s?.total_negative ?? null,
    totalReviews: s?.total_reviews ?? null,
  }
}

const searchAppsResponse = z.array(
  z
    .object({
      appid: z.union([z.string(), z.number()]),
      name: z.string(),
    })
    .passthrough(),
)

/**
 * Steam's public app search. Returns identifiers and names only, which is exactly
 * what the live search fallback needs: enough to enqueue the real ingest, not
 * enough to be served as a listing.
 */
export async function searchApps(term: string, limit = 20): Promise<{ appid: string; name: string }[]> {
  const url = `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(term)}`
  const body = await paced(() => fetchJson('steam', url, searchAppsResponse))
  return body.slice(0, limit).map((r) => ({ appid: String(r.appid), name: r.name }))
}

/** The full public catalogue. Large; cached with its own long TTL. */
export async function fetchAppList(): Promise<{ appid: number; name: string }[]> {
  const url = `${API}/ISteamApps/GetAppList/v2/`
  const body = await paced(() => fetchJson('steam', url, appListResponse, { timeoutMs: 60_000 }))
  return body.applist.apps
}

/**
 * Valve's official most-played chart.
 *
 * Steam publishes no free / paid / grossing charts, so this is NOT presented as
 * an equivalent of the client's three sorts. It is offered under its own name so
 * Steam has a real ranking of its own instead of a fabricated one.
 */
export async function fetchMostPlayed(): Promise<{ rank: number; appid: number }[]> {
  const url = `${API}/ISteamChartsService/GetMostPlayedGames/v1/`
  const body = await paced(() => fetchJson('steam', url, mostPlayedResponse))
  return body.response.ranks.map((r) => ({ rank: r.rank, appid: r.appid }))
}
