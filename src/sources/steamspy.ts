/**
 * SteamSpy: bulk review counts for Steam, cheaply.
 *
 * WHY THIS EXISTS
 *
 * Valve's `appreviews` gives exact review counts but costs one request per game.
 * Filling a catalogue of several thousand Steam titles that way is thousands of
 * requests for a number that changes slowly. SteamSpy's `request=all` returns
 * 1,000 games per call with `positive` and `negative` already in it, which
 * covers the same ground in three or four requests.
 *
 * WHAT IT IS NOT
 *
 * SteamSpy is a third party, not Valve, and its numbers lag. Measured
 * 2026-07-27 against Counter-Strike 2:
 *
 *   SteamSpy  7,642,084 positive / 1,173,003 negative  ->  86.7% positive
 *   Valve     8,387,623 positive / 1,359,828 negative  ->  86.0% positive
 *
 * About 9% behind on absolute counts, but within 0.7 points on the ratio. That
 * shape of error is exactly what decides how it is used here:
 *
 *   - good enough to pre-fill the ratio, the label and a rough magnitude
 *   - NOT good enough to be presented as the review count
 *
 * So everything it produces is marked `authoritative: false` and carries its
 * provider in `provenance`. Valve's own endpoint overwrites it whenever a record
 * is refreshed individually. A consumer can always see which one they are
 * looking at; that is the whole point of recording provenance rather than
 * silently mixing two providers into one number.
 *
 * RATE LIMITS
 *
 * SteamSpy documents 1 request per 60 seconds for `request=all` and 1 per second
 * for everything else. The shared pacer covers the per-second case; the `all`
 * endpoint additionally holds its own gate, because exceeding that one gets the
 * IP throttled and this is a courtesy API run by one person.
 */
import { z } from 'zod'
import { fetchJson } from '../lib/http.ts'
import { pacers, sleep } from '../lib/pacer.ts'
import { SourceError } from '../lib/source-errors.ts'
import { logger } from '../lib/logger.ts'

const BASE = 'https://steamspy.com/api.php'

/** Documented minimum spacing for `request=all`. Not negotiable downward. */
export const ALL_ENDPOINT_MIN_INTERVAL_MS = 60_000

/** Pages are 1,000 entries, ordered by owners descending. */
export const PAGE_SIZE = 1000

const entry = z
  .object({
    appid: z.number(),
    name: z.string().optional(),
    positive: z.number().optional(),
    negative: z.number().optional(),
    developer: z.string().nullable().optional(),
    publisher: z.string().nullable().optional(),
    owners: z.string().optional(),
    ccu: z.number().optional(),
  })
  .passthrough()

const allResponse = z.record(z.string(), z.unknown())

export interface SteamSpyEntry {
  appId: string
  name: string | null
  positive: number | null
  negative: number | null
  developer: string | null
  publisher: string | null
  /** SteamSpy's owner estimate, a wide range like "100,000,000 .. 200,000,000". */
  owners: string | null
  concurrentUsers: number | null
}

function toEntry(raw: unknown): SteamSpyEntry | null {
  const parsed = entry.safeParse(raw)
  if (!parsed.success) return null
  const e = parsed.data
  return {
    appId: String(e.appid),
    name: e.name ?? null,
    positive: e.positive ?? null,
    negative: e.negative ?? null,
    developer: e.developer ?? null,
    publisher: e.publisher ?? null,
    owners: e.owners ?? null,
    concurrentUsers: e.ccu ?? null,
  }
}

let lastAllCallAt = 0

async function paced<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const result = await pacers.steamspy.run(fn)
    pacers.steamspy.recordSuccess()
    return result
  } catch (error) {
    if (error instanceof SourceError) pacers.steamspy.recordFailure(error)
    throw error
  }
}

/**
 * One page of 1,000 games, ordered by owners descending.
 *
 * Page 0 is therefore the most-owned 1,000 games on Steam, which is the part of
 * the catalogue anybody is going to build a page for. Three pages covers the top
 * 3,000 for three requests.
 */
export async function fetchAllPage(page: number): Promise<SteamSpyEntry[]> {
  const wait = lastAllCallAt + ALL_ENDPOINT_MIN_INTERVAL_MS - Date.now()
  if (wait > 0) {
    logger.info('waiting on the SteamSpy bulk endpoint rate limit', {
      seconds: Math.ceil(wait / 1000),
      page,
    })
    await sleep(wait)
  }
  lastAllCallAt = Date.now()

  const url = `${BASE}?request=all&page=${page}`
  const body = await paced(() => fetchJson('steamspy', url, allResponse, { timeoutMs: 60_000 }))

  const entries: SteamSpyEntry[] = []
  for (const value of Object.values(body)) {
    const parsed = toEntry(value)
    if (parsed) entries.push(parsed)
  }

  // An entirely unparseable page is a format change, not an empty page.
  if (entries.length === 0 && Object.keys(body).length > 0) {
    throw new SourceError('steamspy', 'malformed', 'No usable entry in the SteamSpy page.', {
      detail: { page, received: Object.keys(body).length },
    })
  }
  return entries
}

/** One game. Used to fill a gap the bulk pages did not cover. */
export async function fetchAppDetails(appId: string): Promise<SteamSpyEntry | null> {
  const url = `${BASE}?request=appdetails&appid=${encodeURIComponent(appId)}`
  const body = await paced(() => fetchJson('steamspy', url, z.unknown()))
  return toEntry(body)
}
