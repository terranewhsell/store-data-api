/**
 * Our own Google Play parser.
 *
 * Replaces the one thing in this service that was somebody else's code. App
 * Store and Steam were always our own requests against Apple's and Valve's
 * public APIs; Play was the exception, and this closes it.
 *
 * What it does that a coordinate-only parser cannot: it reads the page twice,
 * once through Google's schema.org data and once through the obfuscated payload,
 * and compares them. A parser that only knows positions cannot distinguish "this
 * app has no rating" from "ratings moved to a different index". This one gets a
 * second opinion, so a format change surfaces as a reported disagreement instead
 * of a silent null.
 *
 * The output is deliberately shaped like google-play-scraper's, field for field,
 * so the two can be swapped and compared without touching anything downstream.
 * See `src/cli/compare-parsers.ts`.
 */
import { config } from '../../config.ts'
import { toPlainText } from '../../lib/html.ts'
import { fetchText } from '../../lib/http.ts'
import { pacers } from '../../lib/pacer.ts'
import { SourceError } from '../../lib/source-errors.ts'
import { extractFields, extractionIsSound, type ExtractionReport } from './extract.ts'
import { parseDataStore } from './datastore.ts'
import { parseStructuredData } from './structured.ts'

const BASE = 'https://play.google.com/store/apps/details'

export interface PlayFetchParams {
  appId: string
  lang: string
  country: string
}

export interface OwnParseResult {
  app: Record<string, unknown>
  report: ExtractionReport
  /** The page as served. Stored so a future parser can be built without refetching. */
  html: string
}

export function buildUrl(params: PlayFetchParams): string {
  const qs = new URLSearchParams({
    id: params.appId,
    hl: params.lang,
    gl: params.country,
  })
  return `${BASE}?${qs.toString()}`
}

/**
 * Parses an already-fetched page. Separate from fetching so the whole parser can
 * be tested and re-run against stored HTML with no network at all.
 */
export function parsePlayHtml(html: string, params: PlayFetchParams): OwnParseResult {
  const store = parseDataStore(html)
  const structured = parseStructuredData(html)
  const result = extractFields(store, structured)

  const sound = extractionIsSound(result)
  if (!sound.ok) {
    throw new SourceError(
      'play',
      'malformed',
      `Could not parse the Google Play page: ${sound.reason}. Refusing to store it.`,
      {
        detail: {
          appId: params.appId,
          dataBlocks: result.report.dataBlocks,
          structured: result.report.structuredPresent,
          drift: result.report.drift.slice(0, 3),
        },
      },
    )
  }

  // Shaped like google-play-scraper's output so the two are directly comparable.
  const app: Record<string, unknown> = {
    ...result.fields,
    appId: params.appId,
    url: buildUrl(params),
  }

  // The library derives these; mirrored so a field-by-field diff is honest.
  app.developerInternalID = app.developerId
  app.free = typeof app.price === 'number' ? app.price === 0 : null
  app.comments = []

  /**
   * The plain-text description, from the HTML one.
   *
   * Google only ships the marked-up version; the library strips the tags to
   * produce `description`. Doing the same here keeps both fields meaning what
   * the client's example says they mean, and it is a formatting change rather
   * than invented content.
   */
  app.description =
    typeof app.descriptionHTML === 'string' ? toPlainText(app.descriptionHTML) : null

  /**
   * Categories fall back to the genre when the dedicated slot is empty.
   *
   * Google leaves `[118]` empty on most listings and shows the genre instead, so
   * the library derives the single-entry list from `genre` and `genreId`. The
   * client's own example shows that shape, `[{ name: 'Tools', id: 'TOOLS' }]`,
   * so it is a contract detail rather than a library quirk.
   */
  if (!Array.isArray(app.categories) || app.categories.length === 0) {
    app.categories =
      app.genre !== null || app.genreId !== null
        ? [{ name: (app.genre as string) ?? null, id: (app.genreId as string) ?? null }]
        : []
  }

  return { app, report: result.report, html }
}

/**
 * Fetches and parses one listing.
 *
 * Goes through the same pacer and the same block detection as everything else:
 * this is still the one source that bans by IP, and owning the parser does not
 * change that.
 */
export async function fetchApp(params: PlayFetchParams): Promise<OwnParseResult> {
  const url = buildUrl(params)

  const html = await pacers.play.run(() =>
    fetchText('play', url, {
      timeoutMs: config.HTTP_TIMEOUT_MS,
      headers: {
        // Play serves a reduced page to clients that do not look like browsers,
        // and the reduced page has no structured data at all.
        accept: 'text/html,application/xhtml+xml',
        'accept-language': `${params.lang},en;q=0.8`,
      },
    }),
  )

  try {
    const parsed = parsePlayHtml(html, params)
    pacers.play.recordSuccess()
    return parsed
  } catch (error) {
    if (error instanceof SourceError) pacers.play.recordFailure(error)
    throw error
  }
}

export { extractFields, extractionIsSound } from './extract.ts'
export { parseDataStore } from './datastore.ts'
export { parseStructuredData } from './structured.ts'
export type { ExtractionReport } from './extract.ts'
