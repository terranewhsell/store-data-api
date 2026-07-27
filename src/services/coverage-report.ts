/**
 * The answer to "why is this field empty?", per source, in one place.
 *
 * Two halves, and both matter:
 *
 *   declared  what each source CAN fill, from the static matrix. This is a
 *             promise about the shape of the data and it does not change with
 *             the contents of the database.
 *   observed  what each source ACTUALLY filled, measured across every stored
 *             row right now.
 *
 * Declared alone is a claim. Observed alone is a snapshot with no explanation.
 * Together they let a consumer see that `installs` is empty for App Store
 * listings because Apple publishes no install counts, and separately that
 * `recentChanges` is 60 percent filled because plenty of developers leave the
 * release notes blank. One is a property of the store, the other is a property
 * of the world, and neither is a bug in this service.
 *
 * That distinction is the point of the endpoint: without it, every null looks
 * like something we got wrong.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.ts'
import { CANONICAL_FIELDS, SOURCES, type CanonicalField, type Source } from '../normalize/contract.ts'
import { coverageReport as staticMatrix } from '../normalize/coverage.ts'

export interface FieldCoverageReport {
  field: CanonicalField
  /** null when the source can fill it; otherwise why it cannot. */
  declared: 'not_applicable' | 'not_available' | null
  /** Rows where this field held a real value. */
  filled: number
  total: number
  /** 0-100, one decimal. Null when there are no rows yet to measure. */
  fillRate: number | null
}

export interface SourceCoverage {
  source: Source
  listings: number
  fields: FieldCoverageReport[]
  /** Cross-store equivalents this source populates, and where each comes from. */
  common: { field: string; filledFrom: string | null; note: string }[]
  notes: string[]
}

/**
 * What each source puts into the `common` block, and from which of its own
 * fields. Documented here rather than inferred, because "this is empty because
 * Apple has no such field" is a fact about Apple, not something to be guessed
 * from a count of nulls.
 */
const COMMON_SOURCES: Record<Source, { field: string; filledFrom: string | null; note: string }[]> = {
  play: [
    { field: 'minimumOs', filledFrom: 'androidVersion', note: 'null version when Play reports VARY' },
    { field: 'downloadSizeBytes', filledFrom: null, note: 'Google Play does not publish a download size' },
    { field: 'supportedLanguages', filledFrom: null, note: 'not published on the listing' },
    { field: 'publisher', filledFrom: null, note: 'Play has no publisher separate from the developer' },
    {
      field: 'reviewSummary',
      filledFrom: 'histogram',
      note: 'derived: 4-5 stars positive, 1-2 negative, 3-star ratings excluded as neutral',
    },
  ],
  ios: [
    { field: 'minimumOs', filledFrom: 'minimumOsVersion', note: 'exact iOS version' },
    { field: 'downloadSizeBytes', filledFrom: 'fileSizeBytes', note: 'Apple publishes this; Google Play does not' },
    { field: 'supportedLanguages', filledFrom: 'languageCodesISO2A', note: 'ISO codes' },
    { field: 'publisher', filledFrom: 'sellerName', note: 'only when it differs from artistName' },
    {
      field: 'reviewSummary',
      filledFrom: null,
      note: 'Apple publishes an average and a count but no positive/negative split, and a mean cannot be split back',
    },
  ],
  steam: [
    {
      field: 'minimumOs',
      filledFrom: 'platforms + pc_requirements.minimum',
      note: 'platform is structured; version parsed conservatively from publisher-written prose and left null when ambiguous',
    },
    {
      field: 'downloadSizeBytes',
      filledFrom: null,
      note: 'stated only inside free-form requirements text; parsing a number out of it would be a guess',
    },
    { field: 'supportedLanguages', filledFrom: 'supported_languages', note: 'display names, tags stripped' },
    { field: 'publisher', filledFrom: 'publishers[0]', note: 'Steam separates publisher from developer' },
    {
      field: 'reviewSummary',
      filledFrom: 'appreviews query_summary, or SteamSpy in bulk',
      note: 'provenance records which; SteamSpy is marked authoritative:false and runs about 9% below Valve',
    },
  ],
}

const NOTES: Record<Source, string[]> = {
  play: [
    'The canonical contract IS this source\'s shape: the client\'s example was google-play-scraper output.',
    'editorsChoice and features were in that example but the current library no longer extracts them; Google stopped exposing them in the page payload.',
    'The only source that is real scraping, and the only one that can get the IP banned.',
  ],
  ios: [
    'Read through Apple\'s official iTunes Search/Lookup API. Not scraping.',
    'Everything marked not_available exists on the App Store product page but not in the public API. Filling it would mean scraping Apple, which is what using the official API was meant to avoid.',
    'lookup accepts 200 ids per call, so bulk refresh here is far cheaper than Google Play.',
    'Chart position is the closest thing to a popularity signal for this source, because Apple publishes no install counts anywhere. See common.rankings.',
  ],
  steam: [
    'Read through Valve\'s public store endpoints. Not scraping.',
    'histogram is null and is NOT derived: Steam publishes a positive/negative split, and two numbers cannot honestly become five per-star buckets.',
    'score IS derived from that split so Steam titles can be ordered next to the other two sources. The formula is in _meta.derivedFields and the untouched numbers are in extra.steam.',
    'appdetails is public and universally used but Valve does not formally document it, so its shape is validated on every call.',
  ],
}

/**
 * Measured fill rate per canonical field.
 *
 * One query per source over the stored JSON. An empty string, an empty array and
 * a JSON null all count as unfilled: a consumer asking "is this populated" does
 * not care which flavour of empty it is.
 */
async function observedFill(source: Source): Promise<Map<string, { filled: number; total: number }>> {
  const db = getDb()
  const rows = await db.execute(sql`
    SELECT key,
           count(*)::int AS total,
           count(*) FILTER (
             WHERE value <> 'null'::jsonb
               AND value <> '[]'::jsonb
               AND value <> '""'::jsonb
           )::int AS filled
      FROM app_locales, jsonb_each(core)
     WHERE source = ${source}
     GROUP BY key
  `)

  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
    key: string
    total: number | string
    filled: number | string
  }[]

  const out = new Map<string, { filled: number; total: number }>()
  for (const row of list) {
    out.set(row.key, { filled: Number(row.filled), total: Number(row.total) })
  }
  return out
}

export async function buildCoverageReport(): Promise<{
  generated_at: string
  sources: SourceCoverage[]
  legend: Record<string, string>
}> {
  const matrix = staticMatrix()
  const sources: SourceCoverage[] = []

  for (const source of SOURCES) {
    const observed = await observedFill(source)
    const listings = [...observed.values()][0]?.total ?? 0

    const fields: FieldCoverageReport[] = CANONICAL_FIELDS.map((field) => {
      const stats = observed.get(field)
      const total = stats?.total ?? listings
      const filled = stats?.filled ?? 0
      return {
        field,
        declared: matrix[source][field] ?? null,
        filled,
        total,
        fillRate: total > 0 ? Number(((filled / total) * 100).toFixed(1)) : null,
      }
    })

    sources.push({
      source,
      listings,
      fields,
      common: COMMON_SOURCES[source],
      notes: NOTES[source],
    })
  }

  return {
    generated_at: new Date().toISOString(),
    sources,
    legend: {
      declared_not_applicable:
        'The store has no such concept. An Android version requirement for a Steam game is a category error, not missing data.',
      declared_not_available:
        'The concept exists in that store but the official API we use does not return it. These could be filled later, at a cost worth weighing.',
      declared_null:
        'The source can fill this field. A low fill rate here means the developers left it blank, not that we failed to read it.',
      fillRate: 'Percentage of stored listings for this source where the field held a real value.',
      common:
        'Cross-store equivalents. A canonical field keeps its platform-specific meaning and stays null where it does not apply; common answers the same question in a platform-neutral shape.',
    },
  }
}
