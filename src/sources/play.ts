/**
 * Google Play source. Entirely our own.
 *
 * Every operation here — the listing, the charts, search, the developer
 * catalogue, similar apps — is our own request and our own parser, in
 * `./play-parser`. No third-party scraper is imported, at runtime or otherwise;
 * `google-play-scraper` remains a dev dependency used only by
 * `bun run compare-parsers`, which exists to check our output against it.
 *
 * Verified before the switch: 47 of 47 listing fields identical on live pages,
 * and all three charts identical and in the same order.
 *
 * This is still the only one of the three sources that is real scraping, the
 * only one that can get the IP banned, and the only one that sits against a
 * store's terms of use. Owning the parser changes none of that. Every request
 * goes through the pacer, and never from a user-facing request path.
 */
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
 * Returns the page itself alongside the parsed result, plus a report of how each
 * field was resolved and whether the two readings of the page agreed. Storing
 * the page is what makes reprocessing possible without asking Google again.
 */
export async function fetchAppDetailed(params: PlayAppParams): Promise<PlayAppResult> {
  const result = await ownParser.fetchApp(params)
  return { app: result.app as PlayRawApp, html: result.html, report: result.report }
}

export async function fetchApp(params: PlayAppParams): Promise<PlayRawApp> {
  return (await fetchAppDetailed(params)).app
}

/**
 * A ranking for one collection and category.
 *
 * The category must be one Google actually knows about. Our canonical list has
 * one entry, GAME_WORLD, that is not part of Play's taxonomy; sending it makes
 * the chart RPC reject it. Callers filter against
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

  const apps = await fetchChart({
    collection: params.collection,
    category: params.category,
    num: params.num,
    lang: params.lang,
    country: params.country,
  })
  return apps as unknown as Record<string, unknown>[]
}

/**
 * Live search against Play.
 *
 * Present because ingestion needs it to discover apps. It is NEVER wired to
 * `/v1/search`: a user-triggered request to Play on every query is the fastest
 * possible way to lose the IP.
 */
export async function fetchSearch(params: PlaySearchParams): Promise<Record<string, unknown>[]> {
  const apps = await ownPages.search(params.term, {
    lang: params.lang,
    country: params.country,
    num: params.num,
  })
  return apps as unknown as Record<string, unknown>[]
}

/**
 * Apps Play considers similar to a given one. This is the cheapest way to grow
 * the catalogue: every listing we already have points at more listings, so the
 * corpus expands from the seeds without depending on any external list.
 */
export async function fetchSimilar(params: PlayAppParams): Promise<Record<string, unknown>[]> {
  const apps = await ownPages.similarApps(params.appId, {
    lang: params.lang,
    country: params.country,
  })
  return apps as unknown as Record<string, unknown>[]
}

/** Everything else published by the same developer. */
export async function fetchDeveloperApps(params: {
  devId: string
  lang: string
  country: string
  num?: number
}): Promise<Record<string, unknown>[]> {
  const apps = await ownPages.developerApps(params.devId, {
    lang: params.lang,
    country: params.country,
    ...(params.num !== undefined ? { num: params.num } : {}),
  })
  return apps as unknown as Record<string, unknown>[]
}

export const PLAY_COLLECTIONS = ['TOP_FREE', 'TOP_PAID', 'GROSSING'] as const
export type PlayCollection = (typeof PLAY_COLLECTIONS)[number]
