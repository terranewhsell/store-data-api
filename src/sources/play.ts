/**
 * Google Play source.
 *
 * The object the client specified IS the output of `google-play-scraper`, so the
 * library is the source of truth for this store and we do not write a competing
 * HTML parser. What this module adds is everything the library deliberately does
 * not do: pacing, block detection, error classification, and a shape check.
 *
 * This is the only one of the three sources that is real scraping, the only one
 * that can get the IP banned, and the only one that sits against a store's terms
 * of use. Every request to it goes through the pacer. No exceptions, and never
 * from a user-facing request path.
 */
import gplay from 'google-play-scraper'
import { z } from 'zod'
import { config } from '../config.ts'
import { pacers } from '../lib/pacer.ts'
import { SourceError } from '../lib/source-errors.ts'
import { logger } from '../lib/logger.ts'
import { PLAY_INGESTABLE_CATEGORY_IDS } from '../data/categories.ts'
import * as ownParser from './play-parser/index.ts'
import * as ownPages from './play-parser/pages.ts'
import { fetchChart } from './play-parser/charts.ts'
import type { ExtractionReport as OwnExtractionReport } from './play-parser/index.ts'

/**
 * Options handed to the HTTP client inside google-play-scraper. Both settings are
 * load-bearing.
 *
 * `timeout`: the library uses `got`, which by default waits forever. Our own
 * HTTP timeout does not apply to it, so without this a single stalled request
 * hangs the ingest worker indefinitely. That is exactly the failure the client
 * already lived through on the coupons project, where a queue crawled for hours
 * with nothing to show it. Observed here too: a rate check sat for nineteen
 * minutes on one request before this was added.
 *
 * `retry`: got retries GET requests twice on its own by default. That means the
 * pacer counts one request while three leave the machine, silently tripling the
 * rate against the one source that bans by IP. Retries belong to our queue, which
 * has backoff and a circuit breaker; got must do none of its own.
 */
const PLAY_REQUEST_OPTIONS = {
  timeout: { request: config.HTTP_TIMEOUT_MS },
  retry: { limit: 0 },
} as const

export interface PlayAppParams {
  appId: string
  lang: string
  country: string
}

export interface PlayListParams {
  collection: 'TOP_FREE' | 'TOP_PAID' | 'GROSSING'
  category: string
  num: number
  lang: string
  country: string
}

export interface PlaySearchParams {
  term: string
  num: number
  lang: string
  country: string
}

/**
 * Minimum viable shape of an app payload. This is not validation for its own
 * sake: when Google changes the page structure the library silently returns an
 * object with every field undefined, and without this check that would be stored
 * as a real app with no data. A missing title means the parse failed.
 */
const playAppShape = z
  .object({
    title: z.string().min(1),
    appId: z.string().min(1),
  })
  .passthrough()

const playListItemShape = z
  .object({
    appId: z.string().min(1),
  })
  .passthrough()

export type PlayRawApp = z.infer<typeof playAppShape> & Record<string, unknown>

/** Translates whatever the library threw into our classified error type. */
function classify(error: unknown, context: Record<string, unknown>): SourceError {
  const err = error as { message?: string; status?: number; name?: string }
  const status = typeof err?.status === 'number' ? err.status : undefined
  const message = err?.message ?? String(error)

  if (status === 404 || /App not found/i.test(message)) {
    return new SourceError('play', 'not_found', 'App not found on Google Play.', {
      status,
      detail: context,
      cause: error,
    })
  }
  if (status === 429) {
    return new SourceError('play', 'rate_limited', 'Google Play returned 429.', {
      status,
      detail: context,
      cause: error,
    })
  }
  if (status === 403 || status === 401 || /consent|captcha|unusual traffic/i.test(message)) {
    return new SourceError('play', 'blocked', 'Google Play refused the request.', {
      status,
      detail: context,
      cause: error,
    })
  }
  if (status !== undefined && status >= 500) {
    return new SourceError('play', 'unavailable', `Google Play returned ${status}.`, {
      status,
      detail: context,
      cause: error,
    })
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return new SourceError('play', 'timeout', 'Google Play request timed out.', {
      detail: context,
      cause: error,
    })
  }
  return new SourceError('play', 'unavailable', `Google Play request failed: ${message}`, {
    status,
    detail: context,
    cause: error,
  })
}

async function paced<T>(fn: () => Promise<T>, context: Record<string, unknown>): Promise<T> {
  try {
    const result = await pacers.play.run(fn)
    pacers.play.recordSuccess()
    return result
  } catch (error) {
    if (error instanceof SourceError) {
      pacers.play.recordFailure(error)
      throw error
    }
    // BreakerOpenError and anything else non-source-shaped passes through
    // untouched: it is not a fresh signal about the source's health.
    if (error instanceof Error && error.name === 'BreakerOpenError') throw error
    const classified = classify(error, context)
    pacers.play.recordFailure(classified)
    throw classified
  }
}

export interface PlayAppResult {
  app: PlayRawApp
  /** Present when our own parser ran; the library never exposes the page. */
  html?: string
  /** Present when our own parser ran: which strategy answered each field. */
  report?: OwnExtractionReport
}

/**
 * One listing, through whichever parser is configured.
 *
 * `PLAY_PARSER=own` uses ours, which additionally returns the page itself and a
 * report of how each field was resolved. `library` uses google-play-scraper and
 * returns neither, because it never exposes the page it fetched.
 */
export async function fetchAppDetailed(params: PlayAppParams): Promise<PlayAppResult> {
  if (config.PLAY_PARSER === 'own') {
    const result = await ownParser.fetchApp(params)
    return { app: result.app as PlayRawApp, html: result.html, report: result.report }
  }
  return { app: await fetchApp(params) }
}

export async function fetchApp(params: PlayAppParams): Promise<PlayRawApp> {
  const raw = await paced(
    () =>
      // The library reads `requestOptions` (lib/app.js merges it into the got
      // options) but its shipped .d.ts omits the field, so the cast is a typing
      // gap rather than an unsupported option.
      gplay.app({
        appId: params.appId,
        lang: params.lang,
        country: params.country,
        requestOptions: PLAY_REQUEST_OPTIONS,
      } as Parameters<typeof gplay.app>[0]),
    { appId: params.appId, lang: params.lang, country: params.country },
  )

  const parsed = playAppShape.safeParse(raw)
  if (!parsed.success) {
    const error = new SourceError(
      'play',
      'malformed',
      'Google Play returned a payload we could not parse. Refusing to store it.',
      {
        detail: {
          appId: params.appId,
          issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')),
        },
      },
    )
    pacers.play.recordFailure(error)
    throw error
  }
  return parsed.data as PlayRawApp
}

/**
 * A ranking for one collection and category.
 *
 * The category must be one Google actually knows about. Our canonical list has
 * one entry, GAME_WORLD, that is not part of Play's taxonomy; sending it makes
 * the library throw `Invalid category`. Callers filter against
 * PLAY_INGESTABLE_CATEGORY_IDS, and this guard is the second line of defence.
 */
export async function fetchList(params: PlayListParams): Promise<Record<string, unknown>[]> {
  // Validated against OUR canonical list, not the library's constants. The two
  // agree, and a test asserts they still do, but the runtime path must not
  // depend on a third party to know which categories exist.
  if (!PLAY_INGESTABLE_CATEGORY_IDS.includes(params.category)) {
    throw new SourceError(
      'play',
      'not_found',
      `Category ${params.category} does not exist in Google Play's taxonomy.`,
      { detail: { category: params.category } },
    )
  }

  /**
   * Charts are the one Play operation still not fully ours.
   *
   * Everything else on this store now runs on our own parser: the listing, the
   * search, the developer catalogue and the similar-apps strip all come from
   * ordinary HTML pages we fetch and parse. Charts do not. Play loads them
   * through `batchexecute`, its internal RPC, and getting that call accepted
   * needs more than the right payload: our implementation in
   * `play-parser/charts.ts` sends a byte-identical body to a working one and
   * still gets an empty stream back, because the library's HTTP client carries a
   * cookie jar and a set of defaults we have not matched. The request shape,
   * the query parameters, the field mask and the response reader are all
   * written and tested; the transport is what is missing.
   *
   * So ours is attempted first and the library catches the fall. The day the
   * transport is solved, this starts using ours with no other change. Until
   * then the charts keep working, which matters more than the purity of the
   * dependency graph, and the log says plainly which one served the request.
   */
  if (config.PLAY_PARSER === 'own' && config.PLAY_OWN_CHARTS) {
    try {
      const apps = await fetchChart({
        collection: params.collection,
        category: params.category,
        num: params.num,
        lang: params.lang,
        country: params.country,
      })
      return apps as unknown as Record<string, unknown>[]
    } catch (error) {
      logger.warn('own chart parser failed, falling back to the library', {
        collection: params.collection,
        category: params.category,
        error: error instanceof Error ? error.message.slice(0, 160) : String(error),
      })
    }
  }

  const raw = await paced(
    () =>
      gplay.list({
        collection: params.collection as never,
        category: params.category as never,
        num: params.num,
        lang: params.lang,
        country: params.country,
        requestOptions: PLAY_REQUEST_OPTIONS as never,
      }),
    { collection: params.collection, category: params.category },
  )

  if (!Array.isArray(raw)) {
    const error = new SourceError('play', 'malformed', 'Google Play list response was not an array.', {
      detail: { collection: params.collection, category: params.category },
    })
    pacers.play.recordFailure(error)
    throw error
  }

  const items: Record<string, unknown>[] = []
  let dropped = 0
  for (const item of raw) {
    const parsed = playListItemShape.safeParse(item)
    if (parsed.success) items.push(parsed.data as Record<string, unknown>)
    else dropped += 1
  }

  // An entirely unparseable list is a format change, not an empty ranking.
  if (items.length === 0 && raw.length > 0) {
    const error = new SourceError('play', 'malformed', 'No entry in the Play list had an appId.', {
      detail: { collection: params.collection, category: params.category, received: raw.length },
    })
    pacers.play.recordFailure(error)
    throw error
  }
  if (dropped > 0) {
    logger.warn('play list entries dropped', {
      collection: params.collection,
      category: params.category,
      dropped,
      kept: items.length,
    })
  }
  return items
}

/**
 * Live search against Play.
 *
 * Present because ingestion needs it to discover apps. It is NEVER wired to
 * `/v1/search`: a user-triggered request to Play on every query is the fastest
 * possible way to lose the IP.
 */
export async function fetchSearch(params: PlaySearchParams): Promise<Record<string, unknown>[]> {
  if (config.PLAY_PARSER === 'own') {
    const apps = await ownPages.search(params.term, {
      lang: params.lang,
      country: params.country,
      num: params.num,
    })
    return apps as unknown as Record<string, unknown>[]
  }

  const raw = await paced(
    () =>
      gplay.search({
        term: params.term,
        num: params.num,
        lang: params.lang,
        country: params.country,
        requestOptions: PLAY_REQUEST_OPTIONS as never,
      }),
    { term: params.term },
  )
  return Array.isArray(raw) ? (raw as unknown as Record<string, unknown>[]) : []
}

/**
 * Apps Play considers similar to a given one. This is the cheapest way to grow
 * the catalogue: every listing we already have points at more listings, so the
 * corpus expands from the seeds without depending on any external list.
 */
export async function fetchSimilar(params: PlayAppParams): Promise<Record<string, unknown>[]> {
  if (config.PLAY_PARSER === 'own') {
    const apps = await ownPages.similarApps(params.appId, {
      lang: params.lang,
      country: params.country,
    })
    return apps as unknown as Record<string, unknown>[]
  }

  const raw = await paced(
    () =>
      gplay.similar({
        appId: params.appId,
        lang: params.lang,
        country: params.country,
        requestOptions: PLAY_REQUEST_OPTIONS as never,
      }),
    { appId: params.appId, kind: 'similar' },
  )
  return Array.isArray(raw) ? (raw as unknown as Record<string, unknown>[]) : []
}

/** Everything else published by the same developer. */
export async function fetchDeveloperApps(params: {
  devId: string
  lang: string
  country: string
  num?: number
}): Promise<Record<string, unknown>[]> {
  if (config.PLAY_PARSER === 'own') {
    const apps = await ownPages.developerApps(params.devId, {
      lang: params.lang,
      country: params.country,
      ...(params.num !== undefined ? { num: params.num } : {}),
    })
    return apps as unknown as Record<string, unknown>[]
  }

  const raw = await paced(
    () =>
      gplay.developer({
        devId: params.devId,
        lang: params.lang,
        country: params.country,
        num: params.num ?? 60,
        requestOptions: PLAY_REQUEST_OPTIONS as never,
      }),
    { devId: params.devId, kind: 'developer' },
  )
  return Array.isArray(raw) ? (raw as unknown as Record<string, unknown>[]) : []
}

export const PLAY_COLLECTIONS = ['TOP_FREE', 'TOP_PAID', 'GROSSING'] as const
export type PlayCollection = (typeof PLAY_COLLECTIONS)[number]
