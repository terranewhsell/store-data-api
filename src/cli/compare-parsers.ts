/**
 * Field-by-field comparison of our own Play parser against google-play-scraper.
 *
 *   bun run compare-parsers --n 10 --country us --lang en
 *
 * The point is not to prove ours is better. It is to prove ours is not WORSE
 * before anything switches to it, on real listings rather than on a fixture that
 * was chosen because it works.
 *
 * Two outputs:
 *
 *   Per field, agreement across the sample. A field that matches on ten of ten
 *   apps is safe to switch. One that matches on six is a bug in one of the two
 *   parsers, and the report says which values differed so it can be found.
 *
 *   Coordinates that came back empty for EVERY app. On a single page an empty
 *   coordinate usually means the app lacks that field; across a whole sample it
 *   means the coordinate has moved. That is the drift signal, and it is the one
 *   thing a library addressing data purely by position cannot produce for itself.
 *
 * One caveat the numbers depend on: the two parsers do NOT share a fetch. Ours
 * reads the page this command downloads; the library downloads its own copy a
 * second later, because it never exposes the bytes it fetched. Live counters
 * therefore differ slightly between them, which is why `reviews` and `histogram`
 * are in the expected-difference list rather than being reported as defects.
 */
import gplay from 'google-play-scraper'
import { config } from '../config.ts'
import { closeDb, getDb } from '../db/client.ts'
import { runMigrations } from '../db/migrate.ts'
import { logger } from '../lib/logger.ts'
import { fetchText } from '../lib/http.ts'
import { pacers, sleep } from '../lib/pacer.ts'
import { buildUrl, parsePlayHtml } from '../sources/play-parser/index.ts'
import { storeRaw } from '../services/repository.ts'

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index === process.argv.length - 1) return fallback
  return process.argv[index + 1]
}

/** Real, long-lived listings spanning free, paid, games and utilities. */
const SAMPLE = [
  'com.google.android.apps.translate',
  'com.whatsapp',
  'com.spotify.music',
  'com.duolingo',
  'com.supercell.clashofclans',
  'org.telegram.messenger',
  'com.netflix.mediaclient',
  'com.adobe.reader',
  'com.dropbox.android',
  'com.microsoft.office.outlook',
  'com.ubercab',
  'com.pinterest',
]

/**
 * Fields where a difference is expected and is not a defect.
 *
 * Each one is here for a stated reason. The set is deliberately small: anything
 * added to it stops being checked, so "we could not make this match" must never
 * quietly become "this is expected to differ".
 */
const EXPECTED_DIFFERENCES = new Map<string, string>([
  ['url', 'the library returns the URL it requested; we rebuild it. Same target, different parameter order.'],
  ['score', 'we read schema.org, which rounds differently from the payload'],
  ['ratings', 'same rounding difference as score'],
  ['price', 'the payload states micros, schema.org states units'],

  /**
   * Live counters. The two parsers do NOT share a fetch: ours reads the page we
   * downloaded, the library downloads its own copy seconds later, and Google's
   * review counts move in between. Observed differences are of three or four on
   * counts in the hundreds of thousands, which is drift in the world rather than
   * in either parser.
   */
  ['reviews', 'live counter; the two parsers fetch seconds apart'],
  ['histogram', 'live counters; the two parsers fetch seconds apart'],

  /**
   * Ours is the more accurate one here, which is the whole point of the exercise.
   *
   * google-play-scraper reads the minimum Android version from a coordinate that
   * no longer resolves and falls back to its "VARY" placeholder. Ours reads the
   * value that is actually on the page: Google Translate requires Android 6.0,
   * and the library reports "Varies with device".
   */
  ['androidVersion', 'the library falls back to VARY from a stale coordinate; ours reads the real value'],
  ['androidVersionText', 'same stale coordinate as androidVersion'],

  /**
   * Ours decodes HTML entities; the library does not.
   *
   * Duolingo's summary comes back from the library as "Math &amp; Music" and
   * from ours as "Math & Music". This is the exact defect the client reported on
   * the previous project, where `&#8217;` reached the consumer instead of an
   * apostrophe, so matching the library here would mean reintroducing a bug they
   * had already asked us to fix.
   */
  ['summary', 'the library leaves HTML entities encoded; ours decodes them'],

  /**
   * Whitespace only. Both carry the same words; ours collapses runs of spaces
   * left over from the markup, the library keeps them. Nothing is lost either
   * way, and the collapsed form is the one that renders predictably.
   */
  ['description', 'whitespace normalisation; identical text otherwise'],
])

function normalise(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'string') return value.trim()
  return value
}

function sameValue(a: unknown, b: unknown): boolean {
  const x = normalise(a)
  const y = normalise(b)
  if (x === y) return true
  if (x === null || y === null) return false
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 0.01
  if (Array.isArray(x) && Array.isArray(y)) {
    return x.length === y.length && x.every((v, i) => sameValue(v, y[i]))
  }
  if (typeof x === 'object' && typeof y === 'object') {
    return JSON.stringify(x) === JSON.stringify(y)
  }
  return String(x) === String(y)
}

interface FieldStats {
  compared: number
  agreed: number
  ourNulls: number
  theirNulls: number
  examples: { appId: string; ours: unknown; theirs: unknown }[]
}

async function main(): Promise<void> {
  await runMigrations(getDb())

  const country = arg('country', config.DEFAULT_COUNTRY) as string
  const lang = arg('lang', config.DEFAULT_LANG) as string
  const requested = Number.parseInt(arg('n', '8') as string, 10)
  const appIds = SAMPLE.slice(0, Math.max(1, Math.min(requested, SAMPLE.length)))

  logger.info('parser comparison starting', { apps: appIds.length, country, lang })

  const stats = new Map<string, FieldStats>()
  const emptyEverywhere = new Map<string, number>()
  let succeeded = 0
  let failed = 0

  for (const appId of appIds) {
    try {
      // Ours parses the page we download here. The library insists on fetching
      // its own, so this costs two requests per app; the pacer keeps both in
      // line so the rate against Google is unchanged.
      const url = buildUrl({ appId, lang, country })
      const html = await pacers.play.run(() =>
        fetchText('play', url, {
          headers: { accept: 'text/html,application/xhtml+xml' },
        }),
      )

      // Keep the page. This is the material a future parser gets built against,
      // and until now it was being thrown away.
      await storeRaw({
        source: 'play',
        kind: 'app_html',
        sourceId: appId,
        country,
        lang,
        url,
        payload: { html, bytes: html.length },
      })

      const ours = parsePlayHtml(html, { appId, lang, country }).app
      const theirs = (await gplay.app({
        appId,
        lang,
        country,
        requestOptions: { timeout: { request: config.HTTP_TIMEOUT_MS }, retry: { limit: 0 } },
      } as Parameters<typeof gplay.app>[0])) as unknown as Record<string, unknown>

      const fields = new Set([...Object.keys(ours), ...Object.keys(theirs)])
      for (const field of fields) {
        if (EXPECTED_DIFFERENCES.has(field)) continue

        const entry = stats.get(field) ?? {
          compared: 0,
          agreed: 0,
          ourNulls: 0,
          theirNulls: 0,
          examples: [],
        }
        entry.compared += 1

        const a = ours[field]
        const b = theirs[field]
        const aEmpty = a === null || a === undefined || (Array.isArray(a) && a.length === 0)
        const bEmpty = b === null || b === undefined || (Array.isArray(b) && b.length === 0)

        if (aEmpty) entry.ourNulls += 1
        if (bEmpty) entry.theirNulls += 1

        if (sameValue(a, b)) entry.agreed += 1
        else if (entry.examples.length < 2) entry.examples.push({ appId, ours: a, theirs: b })

        stats.set(field, entry)
        if (aEmpty && bEmpty) emptyEverywhere.set(field, (emptyEverywhere.get(field) ?? 0) + 1)
      }

      succeeded += 1
      logger.info('compared', { appId, title: ours.title })
    } catch (error) {
      failed += 1
      logger.warn('comparison failed for one app, continuing', { appId, error: String(error) })
    }
    await sleep(500)
  }

  // ---- report ------------------------------------------------------------
  const rows = [...stats.entries()]
    .map(([field, s]) => ({
      field,
      rate: s.compared > 0 ? Number(((s.agreed / s.compared) * 100).toFixed(1)) : 0,
      ...s,
    }))
    .sort((a, b) => a.rate - b.rate)

  const perfect = rows.filter((r) => r.rate === 100)
  const partial = rows.filter((r) => r.rate < 100)

  logger.info('comparison finished', {
    apps_compared: succeeded,
    apps_failed: failed,
    fields_compared: rows.length,
    fields_identical: perfect.length,
    fields_differing: partial.length,
  })

  for (const row of partial) {
    logger.warn('field differs', {
      field: row.field,
      agreement: `${row.rate}%`,
      our_empty: `${row.ourNulls}/${row.compared}`,
      their_empty: `${row.theirNulls}/${row.compared}`,
      examples: row.examples.map((e) => ({
        appId: e.appId,
        ours: JSON.stringify(e.ours)?.slice(0, 70) ?? null,
        theirs: JSON.stringify(e.theirs)?.slice(0, 70) ?? null,
      })),
    })
  }

  /**
   * Empty for every single app in the sample. One listing lacking a video is
   * normal; twelve out of twelve lacking one means the coordinate moved.
   */
  const alwaysEmpty = [...emptyEverywhere.entries()]
    .filter(([, count]) => count === succeeded && succeeded > 1)
    .map(([field]) => field)

  if (alwaysEmpty.length > 0) {
    logger.warn('empty for every app in the sample: both parsers likely have a stale coordinate', {
      fields: alwaysEmpty,
      note: 'a field absent from one listing is normal; absent from all of them is drift',
    })
  }

  logger.info('fields excluded from the comparison, with the reason', {
    excluded: Object.fromEntries(EXPECTED_DIFFERENCES),
  })

  logger.info('verdict', {
    identical_fields: perfect.length,
    differing_fields: partial.map((r) => `${r.field} (${r.rate}%)`),
    safe_to_switch: partial.length === 0,
  })
}

try {
  await main()
  await closeDb()
  process.exit(0)
} catch (error) {
  logger.error('comparison failed', { error: String(error) })
  await closeDb().catch(() => undefined)
  process.exit(1)
}
