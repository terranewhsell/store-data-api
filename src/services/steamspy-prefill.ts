/**
 * Bulk pre-fill of Steam review counts.
 *
 * THE COST PROBLEM THIS SOLVES
 *
 * Valve's `appreviews` is one request per game. A catalogue of 3,000 Steam
 * titles costs 3,000 requests just for review counts, on top of the 3,000 for
 * the listings themselves. It doubles the ingest for a number that moves slowly.
 *
 * SteamSpy's bulk export returns 1,000 games per request with `positive` and
 * `negative` already present. Three requests instead of three thousand.
 *
 * THE ACCURACY TRADE, STATED PLAINLY
 *
 * SteamSpy lags. Measured 2026-07-27 on Counter-Strike 2 it was about 9 percent
 * low on absolute counts while staying within 0.7 points on the ratio. So it is
 * used for the ratio, the magnitude and the pre-fill, and Valve remains the
 * authority. Every summary records which provider it came from, so the two are
 * never confused for one another.
 *
 * Entries land in `raw_payloads` under kind `steamspy`, next to every other
 * source response, so they are covered by the same reprocessing path as
 * everything else.
 */
import { and, desc, eq, gte } from 'drizzle-orm'
import { config } from '../config.ts'
import { getDb } from '../db/client.ts'
import { rawPayloads } from '../db/schema.ts'
import { logger } from '../lib/logger.ts'
import { isSourceError } from '../lib/source-errors.ts'
import * as steamspy from '../sources/steamspy.ts'
import { recordEvent, storeRaw } from './repository.ts'

export interface PrefillResult {
  pages: number
  entries: number
  withReviews: number
  failed: number
}

/**
 * Fetches the top `pages * 1000` games by owner count and stores their review
 * numbers.
 *
 * Pages are ordered by owners descending, so page 0 is the most-owned 1,000
 * games on Steam: exactly the part of the catalogue anyone builds pages for.
 */
export async function prefillSteamSpy(opts: { pages?: number } = {}): Promise<PrefillResult> {
  const pages = Math.max(1, opts.pages ?? config.STEAMSPY_PAGES)
  const result: PrefillResult = { pages: 0, entries: 0, withReviews: 0, failed: 0 }

  for (let page = 0; page < pages; page++) {
    const startedAt = Date.now()
    try {
      const entries = await steamspy.fetchAllPage(page)
      result.pages += 1
      result.entries += entries.length

      for (const entry of entries) {
        // A row with neither number is not worth a row.
        if (entry.positive === null && entry.negative === null) continue
        result.withReviews += 1

        await storeRaw({
          source: 'steam',
          kind: 'steamspy',
          sourceId: entry.appId,
          payload: entry,
        })
      }

      await recordEvent({
        source: 'steam',
        kind: 'steamspy_prefill',
        sourceId: `page:${page}`,
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
        detail: { page, entries: entries.length },
      })

      logger.info('steamspy page stored', {
        page,
        entries: entries.length,
        with_reviews: result.withReviews,
      })
    } catch (error) {
      result.failed += 1
      await recordEvent({
        source: 'steam',
        kind: 'steamspy_prefill',
        sourceId: `page:${page}`,
        outcome: isSourceError(error) ? error.kind : 'unavailable',
        durationMs: Date.now() - startedAt,
        detail: { page, error: String(error) },
      })
      // One bad page must not abandon the rest; SteamSpy is a courtesy service
      // and an occasional failure is expected, not exceptional.
      logger.warn('steamspy page failed, continuing', { page, error: String(error) })
    }
  }

  return result
}

export interface SteamSpyReviewNumbers {
  positive: number | null
  negative: number | null
  fetchedAt: string
}

/**
 * The stored SteamSpy numbers for one game, if they are fresh enough.
 *
 * Bounded by the review TTL: stale third-party numbers are worse than none,
 * because the ingest would then skip the authoritative call for nothing.
 */
export async function lookupSteamSpy(appId: string): Promise<SteamSpyReviewNumbers | null> {
  const db = getDb()
  const cutoff = new Date(Date.now() - config.TTL_REVIEWS * 1000)

  const rows = await db
    .select()
    .from(rawPayloads)
    .where(
      and(
        eq(rawPayloads.source, 'steam'),
        eq(rawPayloads.kind, 'steamspy'),
        eq(rawPayloads.sourceId, appId),
        gte(rawPayloads.fetchedAt, cutoff),
      ),
    )
    .orderBy(desc(rawPayloads.fetchedAt))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const payload = row.payload as { positive?: number | null; negative?: number | null }
  if (payload.positive === undefined && payload.negative === undefined) return null

  return {
    positive: payload.positive ?? null,
    negative: payload.negative ?? null,
    fetchedAt: row.fetchedAt.toISOString(),
  }
}
