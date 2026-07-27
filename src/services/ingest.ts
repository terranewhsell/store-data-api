/**
 * Ingest.
 *
 * One shape for all three sources: fetch, keep the raw payload, normalize, run
 * the quality gate, store. The raw payload is written BEFORE normalization, so a
 * record that fails the gate can still be reprocessed later without asking the
 * source again. That is the whole point of `renormalize`: the day a store changes
 * a field, and it will, the fix is a re-run over data we already hold.
 *
 * Nothing here decides pacing. Every outbound call goes through the source
 * modules, which go through the pacer, which is the only thing that talks to the
 * network.
 */
import { config } from '../config.ts'
import { logger } from '../lib/logger.ts'
import { isSourceError, SourceError } from '../lib/source-errors.ts'
import { getDb } from '../db/client.ts'
import { rawPayloads } from '../db/schema.ts'
import { and, desc, eq } from 'drizzle-orm'
import type { NormalizedApp, Source } from '../normalize/contract.ts'
import { normalizeIosApp } from '../normalize/ios.ts'
import { normalizePlayApp } from '../normalize/play.ts'
import { normalizeSteamApp } from '../normalize/steam.ts'
import * as ios from '../sources/ios.ts'
import * as play from '../sources/play.ts'
import * as steam from '../sources/steam.ts'
import type { SteamReviewSummary } from '../sources/steam.ts'
import { matchPlayToIos } from './matcher.ts'
import { checkQuality, richness } from './quality.ts'
import { lookupSteamSpy } from './steamspy-prefill.ts'
import {
  markDelisted,
  recordEvent,
  saveMatchCandidates,
  setIosMatch,
  storeLocale,
  storeRaw,
  upsertApp,
  type AppRecord,
} from './repository.ts'

export interface IngestOutcome {
  ok: boolean
  source: Source
  sourceId: string
  slug?: string
  changed?: boolean
  reason?: string
  richness?: number
}

function ttlFor(record: AppRecord): number {
  return record.isPopular ? config.TTL_APP_POPULAR : config.TTL_APP_LONGTAIL
}

/**
 * Shared tail: gate, persist, report. Kept in one place so no source can quietly
 * skip the quality gate.
 */
async function finish(
  normalized: NormalizedApp,
  opts: { kind: string; startedAt: number; markPopular?: boolean },
): Promise<IngestOutcome> {
  const verdict = checkQuality(normalized.core, normalized.source)

  if (!verdict.ok) {
    // Not stored as valid. A catalogue of empty listings is worse than a smaller
    // complete one: the empty pages get built and indexed anyway.
    await recordEvent({
      source: normalized.source,
      kind: opts.kind,
      sourceId: normalized.sourceId,
      outcome: 'incomplete',
      durationMs: Date.now() - opts.startedAt,
      detail: { reasons: verdict.reasons, country: normalized.country, lang: normalized.lang },
    })
    logger.warn('record failed the quality gate, not stored', {
      source: normalized.source,
      sourceId: normalized.sourceId,
      reasons: verdict.reasons,
    })
    return {
      ok: false,
      source: normalized.source,
      sourceId: normalized.sourceId,
      reason: verdict.reasons.join(','),
    }
  }

  const record = await upsertApp({
    source: normalized.source,
    sourceId: normalized.sourceId,
    title: normalized.core.title ?? normalized.sourceId,
    type: normalized.core.type,
    genreId: normalized.core.genreId,
    developerId: normalized.core.developerId,
    ...(opts.markPopular ? { isPopular: true } : {}),
  })

  const { changed } = await storeLocale(record, normalized, ttlFor(record))
  const quality = richness(normalized.core)

  await recordEvent({
    source: normalized.source,
    kind: opts.kind,
    sourceId: normalized.sourceId,
    outcome: 'ok',
    durationMs: Date.now() - opts.startedAt,
    detail: {
      country: normalized.country,
      lang: normalized.lang,
      changed,
      richness: quality,
    },
  })

  return {
    ok: true,
    source: normalized.source,
    sourceId: normalized.sourceId,
    slug: record.slug,
    changed,
    richness: quality,
  }
}

/** Classifies and records a failure, and flags the app when it is truly gone. */
async function fail(
  source: Source,
  sourceId: string,
  kind: string,
  startedAt: number,
  error: unknown,
): Promise<IngestOutcome> {
  const kindOf = isSourceError(error) ? error.kind : 'unavailable'

  if (kindOf === 'not_found') {
    // Gone from the store. Flagged, not deleted: a deleted row leaves an empty
    // page behind and no way to know why.
    await markDelisted(source, sourceId)
  }

  await recordEvent({
    source,
    kind,
    sourceId,
    outcome: kindOf,
    durationMs: Date.now() - startedAt,
    detail: { error: error instanceof Error ? error.message : String(error) },
  })

  return { ok: false, source, sourceId, reason: kindOf }
}

export interface IngestAppOptions {
  country: string
  lang: string
  /** Resolve the App Store cross-link during this ingest. Costs extra calls. */
  resolveIosMatch?: boolean
  markPopular?: boolean
}

export async function ingestPlayApp(
  appId: string,
  opts: IngestAppOptions,
): Promise<IngestOutcome> {
  const startedAt = Date.now()
  try {
    const fetched = await play.fetchAppDetailed({
      appId,
      country: opts.country,
      lang: opts.lang,
    })
    const raw = fetched.app

    // Raw first. If normalization is wrong today, this is what fixes it tomorrow
    // without another request.
    await storeRaw({
      source: 'play',
      kind: 'app',
      sourceId: appId,
      country: opts.country,
      lang: opts.lang,
      url: typeof raw.url === 'string' ? raw.url : null,
      payload: raw,
    })

    /**
     * The page itself, when our own parser ran.
     *
     * The payload above is a PARSED object, so reprocessing it can only re-run
     * our normalizer: it can never correct a parser-level mistake. The other two
     * sources store real API responses, so "reprocess without re-fetching" held
     * for them and quietly did not for Play. Storing the HTML closes that, and
     * it is also the corpus a future parser gets validated against.
     */
    if (fetched.html && config.PLAY_STORE_HTML) {
      await storeRaw({
        source: 'play',
        kind: 'app_html',
        sourceId: appId,
        country: opts.country,
        lang: opts.lang,
        url: typeof raw.url === 'string' ? raw.url : null,
        payload: { html: fetched.html, bytes: fetched.html.length },
      })
    }

    // Drift surfaced by the cross-check is worth a log line even when the record
    // is fine: it is the early warning that coordinates are going stale.
    if (fetched.report && fetched.report.drift.length > 0) {
      logger.warn('play parser drift: structured data and coordinates disagree', {
        appId,
        fields: fetched.report.drift.map((d) => d.field),
      })
    }

    let iosId: string | null = null
    if (opts.resolveIosMatch && typeof raw.title === 'string') {
      iosId = await resolveIosLink(
        { appId, title: raw.title, developer: typeof raw.developer === 'string' ? raw.developer : null },
        opts,
      )
    }

    const normalized = normalizePlayApp(raw, {
      country: opts.country,
      lang: opts.lang,
      iosId,
    })
    return await finish(normalized, {
      kind: 'app',
      startedAt,
      ...(opts.markPopular !== undefined ? { markPopular: opts.markPopular } : {}),
    })
  } catch (error) {
    return fail('play', appId, 'app', startedAt, error)
  }
}

/**
 * Resolves and stores the Play -> App Store link.
 *
 * Returns null unless the match is confident. Everything considered is kept in
 * `match_candidates`, so a human review later does not have to redo the search,
 * and a wrong link never reaches the contract field.
 */
async function resolveIosLink(
  play_: { appId: string; title: string; developer: string | null },
  opts: { country: string; lang: string },
): Promise<string | null> {
  try {
    const outcome = await matchPlayToIos(play_, opts)

    // The candidates need the app row to hang off, so ensure it exists first.
    const record = await upsertApp({
      source: 'play',
      sourceId: play_.appId,
      title: play_.title,
      type: 'app',
      genreId: null,
      developerId: null,
    })

    await saveMatchCandidates(record.id, outcome.candidates)
    await setIosMatch(
      record.id,
      outcome.match
        ? {
            iosId: outcome.match.iosId,
            confidence: outcome.match.confidence,
            method: outcome.match.method,
          }
        : null,
    )
    return outcome.match?.iosId ?? null
  } catch (error) {
    logger.debug('ios match failed, leaving iosId null', {
      appId: play_.appId,
      error: String(error),
    })
    return null
  }
}

/**
 * App Store ingest, in batches.
 *
 * `lookup` takes up to 200 ids in one call, which is why the App Store corpus can
 * be refreshed for a fraction of what Google Play costs. Ids that Apple omits
 * from the response are the ones that no longer exist in that market, so they are
 * flagged as delisted rather than retried forever.
 */
export async function ingestIosApps(
  ids: string[],
  opts: IngestAppOptions,
): Promise<IngestOutcome[]> {
  if (ids.length === 0) return []
  const outcomes: IngestOutcome[] = []

  for (let i = 0; i < ids.length; i += ios.LOOKUP_BATCH_MAX) {
    const batch = ids.slice(i, i + ios.LOOKUP_BATCH_MAX)
    const startedAt = Date.now()

    try {
      const results = await ios.lookup(batch, { country: opts.country, lang: opts.lang })
      await storeRaw({
        source: 'ios',
        kind: 'app',
        sourceId: batch.join(','),
        country: opts.country,
        lang: opts.lang,
        payload: results,
      })

      const returned = new Set<string>()
      for (const app of results) {
        const normalized = normalizeIosApp(app, { country: opts.country, lang: opts.lang })
        returned.add(normalized.sourceId)
        outcomes.push(
          await finish(normalized, {
            kind: 'app',
            startedAt,
            ...(opts.markPopular !== undefined ? { markPopular: opts.markPopular } : {}),
          }),
        )
      }

      for (const requested of batch) {
        const normalizedId = requested.startsWith('id') ? requested : `id${requested}`
        if (returned.has(normalizedId)) continue
        await markDelisted('ios', normalizedId)
        outcomes.push(
          await fail(
            'ios',
            normalizedId,
            'app',
            startedAt,
            new SourceError('ios', 'not_found', 'Apple did not return this id.'),
          ),
        )
      }
    } catch (error) {
      for (const requested of batch) {
        outcomes.push(await fail('ios', requested, 'app', startedAt, error))
      }
    }
  }

  return outcomes
}

/**
 * Steam ingest.
 *
 * Two calls per game: the store listing and the review summary. The reviews call
 * is best-effort, because a game with no reviews yet is a normal state and must
 * not stop the listing from being stored.
 */
export async function ingestSteamApp(
  appId: string,
  opts: IngestAppOptions,
): Promise<IngestOutcome> {
  const startedAt = Date.now()
  try {
    const details = await steam.fetchAppDetails(appId, {
      country: opts.country,
      lang: opts.lang,
    })
    await storeRaw({
      source: 'steam',
      kind: 'app',
      sourceId: appId,
      country: opts.country,
      lang: opts.lang,
      payload: details,
    })

    /**
     * Review numbers, cheapest acceptable source first.
     *
     * Valve's `appreviews` is one request per game. When a fresh SteamSpy figure
     * is already on hand from the bulk pre-fill, that request is skipped: it
     * would spend a request to improve a number by roughly nine percent, which
     * is not worth doubling the ingest cost of the whole catalogue.
     *
     * Whichever is used is recorded in the summary's provenance, so a consumer
     * can always tell an approximate third-party count from the store's own.
     */
    const steamSpy = config.STEAMSPY_ENABLED ? await lookupSteamSpy(appId) : null

    let reviews: steam.SteamReviewSummary | null = null
    if (!steamSpy) {
      try {
        reviews = await steam.fetchReviewSummary(appId)
        await storeRaw({ source: 'steam', kind: 'reviews', sourceId: appId, payload: reviews })
      } catch (error) {
        // A game with no reviews yet is a normal state and must not stop the
        // listing from being stored.
        logger.debug('steam review summary unavailable', { appId, error: String(error) })
      }
    }

    const normalized = normalizeSteamApp(details, {
      country: opts.country,
      lang: opts.lang,
      reviews,
      steamSpy: steamSpy ? { positive: steamSpy.positive, negative: steamSpy.negative } : null,
      fetchedAt: steamSpy?.fetchedAt ?? new Date().toISOString(),
    })
    return await finish(normalized, {
      kind: 'app',
      startedAt,
      ...(opts.markPopular !== undefined ? { markPopular: opts.markPopular } : {}),
    })
  } catch (error) {
    return fail('steam', appId, 'app', startedAt, error)
  }
}

export async function ingestApp(
  source: Source,
  sourceId: string,
  opts: IngestAppOptions,
): Promise<IngestOutcome> {
  if (source === 'play') return ingestPlayApp(sourceId, opts)
  if (source === 'steam') return ingestSteamApp(sourceId, opts)
  const [outcome] = await ingestIosApps([sourceId], opts)
  return outcome ?? { ok: false, source, sourceId, reason: 'no_result' }
}

/**
 * Re-runs normalization over payloads already stored, without touching the
 * network.
 *
 * This exists because store formats change without notice. When that happens the
 * fix is a code change plus this function over the raw table, which is an
 * afternoon. Without the raw table it would mean re-fetching the whole corpus at
 * two seconds per app, which is a week and a fresh chance of being blocked.
 */
export async function renormalize(opts: {
  source: Source
  limit?: number
  country?: string
  lang?: string
}): Promise<{ processed: number; stored: number; failed: number }> {
  const db = getDb()
  const limit = opts.limit ?? 1000

  const conditions = [eq(rawPayloads.source, opts.source), eq(rawPayloads.kind, 'app')]
  if (opts.country) conditions.push(eq(rawPayloads.country, opts.country))
  if (opts.lang) conditions.push(eq(rawPayloads.lang, opts.lang))

  const rows = await db
    .select()
    .from(rawPayloads)
    .where(and(...conditions))
    .orderBy(desc(rawPayloads.fetchedAt))
    .limit(limit)

  let processed = 0
  let stored = 0
  let failed = 0

  /**
   * Steam stores its review summary as a separate payload, because it comes from
   * a separate endpoint. Reprocessing the listing alone would rebuild the record
   * without `score`, `scoreText` or `ratings` and quietly degrade every Steam row
   * it touched. Reprocessing has to reassemble everything the original ingest
   * combined, not just the piece that shares its name with the entity.
   */
  const steamReviews = new Map<string, SteamReviewSummary>()
  const steamSpyNumbers = new Map<string, { positive: number | null; negative: number | null }>()
  if (opts.source === 'steam') {
    const spyRows = await db
      .select()
      .from(rawPayloads)
      .where(and(eq(rawPayloads.source, 'steam'), eq(rawPayloads.kind, 'steamspy')))
      .orderBy(desc(rawPayloads.fetchedAt))
      .limit(limit * 4)

    for (const row of spyRows) {
      if (!row.sourceId || steamSpyNumbers.has(row.sourceId)) continue
      const payload = row.payload as { positive?: number | null; negative?: number | null }
      steamSpyNumbers.set(row.sourceId, {
        positive: payload.positive ?? null,
        negative: payload.negative ?? null,
      })
    }

    const reviewRows = await db
      .select()
      .from(rawPayloads)
      .where(and(eq(rawPayloads.source, 'steam'), eq(rawPayloads.kind, 'reviews')))
      .orderBy(desc(rawPayloads.fetchedAt))
      .limit(limit * 2)

    for (const row of reviewRows) {
      // Newest wins; the ordering above means the first one seen is the newest.
      if (row.sourceId && !steamReviews.has(row.sourceId)) {
        steamReviews.set(row.sourceId, row.payload as SteamReviewSummary)
      }
    }
    logger.info('loaded stored steam review summaries for reprocessing', {
      found: steamReviews.size,
    })
  }

  // Newest payload per source id wins; older ones are history, not input.
  const seen = new Set<string>()

  for (const row of rows) {
    const country = row.country ?? config.DEFAULT_COUNTRY
    const lang = row.lang ?? config.DEFAULT_LANG

    const payloads: unknown[] =
      opts.source === 'ios' && Array.isArray(row.payload) ? row.payload : [row.payload]

    for (const payload of payloads) {
      processed += 1
      try {
        let normalized: NormalizedApp
        if (opts.source === 'play') {
          normalized = normalizePlayApp(payload as Record<string, unknown>, { country, lang })
        } else if (opts.source === 'ios') {
          normalized = normalizeIosApp(payload as never, { country, lang })
        } else {
          const steamAppId = String(
            (payload as Record<string, unknown>)?.steam_appid ?? row.sourceId ?? '',
          )
          normalized = normalizeSteamApp(payload as never, {
            country,
            lang,
            reviews: steamReviews.get(steamAppId) ?? null,
            steamSpy: steamSpyNumbers.get(steamAppId) ?? null,
          })
        }

        const key = `${normalized.sourceId}:${country}:${lang}`
        if (seen.has(key)) continue
        seen.add(key)

        const outcome = await finish(normalized, { kind: 'renormalize', startedAt: Date.now() })
        if (outcome.ok) stored += 1
        else failed += 1
      } catch (error) {
        failed += 1
        logger.warn('renormalize failed for one payload', {
          source: opts.source,
          rawId: row.id,
          error: String(error),
        })
      }
    }
  }

  logger.info('renormalize finished', { source: opts.source, processed, stored, failed })
  return { processed, stored, failed }
}
