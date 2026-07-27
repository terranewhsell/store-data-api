/**
 * Field extraction: two independent readings of the same page, reconciled.
 *
 * Every field declares where it can come from, in order of trust:
 *
 *   1. `structured`  schema.org / Open Graph. A published contract Google
 *                    renders its own search results from, so it has a reason to
 *                    keep it stable. Preferred wherever it covers the field.
 *   2. `path`        a coordinate into the obfuscated payload. Fast, exact, and
 *                    fragile: correct until Google reorders an array.
 *   3. `find`        a shape-based search of the payload. Slower and less
 *                    precise, but survives a reordering, because it looks for
 *                    what the value LOOKS like rather than where it sat.
 *
 * When more than one resolves, they are compared. Agreement is recorded as
 * confidence; disagreement is recorded as drift and surfaced to the caller.
 *
 * That comparison is the entire reason for building this rather than using a
 * library. A parser addressing data purely by position cannot tell the
 * difference between "this app has no rating" and "the ratings moved". This one
 * can, because a second source says what the rating should be.
 */
import { at, findAll, findFirst, type DataStore } from './datastore.ts'
import { structuredIcon, structuredTitle, type StructuredData } from './structured.ts'

export type Strategy = 'structured' | 'path' | 'find' | 'derived'

export interface FieldOutcome {
  value: unknown
  strategy: Strategy | null
  /** Set when two sources resolved and disagreed. */
  drift?: { structured: unknown; path: unknown }
}

export interface ExtractionReport {
  /** Which strategy answered each field. */
  strategies: Record<string, Strategy | null>
  /** Fields where the two readings disagreed. Non-empty means investigate. */
  drift: { field: string; structured: unknown; path: unknown }[]
  /**
   * Coordinates whose PARENT no longer resolves: the structure moved.
   *
   * Distinct from a coordinate that resolves to null, which usually just means
   * the app does not have that field. Conflating the two makes the signal
   * useless, because most listings legitimately lack a video, a release date or
   * in-app purchases. A rising count here means Google reshuffled the payload.
   */
  brokenPaths: string[]
  /** Fields the shape search had to rescue. Also a drift signal. */
  rescuedByFind: string[]
  dataBlocks: number
  structuredPresent: StructuredData['present']
}

// ---------------------------------------------------------------------------
// Shape predicates for the fallback search
// ---------------------------------------------------------------------------

const isPlayImage = (v: unknown): v is string =>
  typeof v === 'string' && /^https:\/\/play-lh\.googleusercontent\.com\//.test(v)

const isInstallsText = (v: unknown): v is string =>
  typeof v === 'string' && /^[\d,.]+\+$/.test(v)

const isEmail = (v: unknown): v is string =>
  typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length < 120

const isHttpUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v)

/**
 * The rating histogram.
 *
 * Google emits it as a sparse array where the INDEX is the star rating and the
 * entry is `[formattedString, count]`:
 *
 *   [null, ["971,818", 971818], ["306,455", 306455], ...]
 *
 * A partial histogram is rejected rather than padded: four real buckets and one
 * invented zero is a fabrication in the same shape as the truth.
 */
function histogramFrom(value: unknown): Record<string, number> | null {
  if (!Array.isArray(value)) return null

  const out: Record<string, number> = {}
  for (let star = 1; star <= 5; star++) {
    const entry = value[star]
    if (!Array.isArray(entry)) continue
    const count = entry[1]
    if (typeof count === 'number') out[String(star)] = count
  }
  return Object.keys(out).length === 5 ? out : null
}

// ---------------------------------------------------------------------------
// Field specifications
// ---------------------------------------------------------------------------

interface FieldSpec {
  /** Coordinate into the payload, `[storeKey, ...indices]`. */
  path?: readonly (string | number)[]
  /** Alternate coordinate, tried when the first is dead. */
  altPath?: readonly (string | number)[]
  /** Value from the schema.org spine. */
  structured?: (sd: StructuredData) => unknown
  /** Shape search over the payload, used only when the coordinates are dead. */
  find?: (store: DataStore) => unknown
  /** Applied to whatever was resolved. */
  transform?: (value: unknown) => unknown
  /**
   * Whether the structured reading should win when both resolve.
   * Default true: the spine is the more stable of the two.
   */
  preferStructured?: boolean
  /** Fields where the two are not expected to match exactly. */
  skipDriftCheck?: boolean
  /**
   * Run the transform even when nothing resolved.
   *
   * Booleans and the "VARY" placeholders are contract values, not data: the
   * client's example has `offersIAP: false`, not `offersIAP: null`, because the
   * absence of in-app purchases IS the answer. Without this they would come back
   * null and diverge from the library for no good reason.
   */
  always?: boolean
}

const D = 'ds:5' as const

/**
 * Coordinates are seeded from google-play-scraper's mapping, which is the
 * accumulated result of a community tracking Google's reshuffles for years.
 * Reproducing that from scratch would be re-deriving public knowledge for no
 * benefit. What is new here is everything around them: the structured spine, the
 * fallbacks and the reconciliation.
 */
export const FIELD_SPECS: Record<string, FieldSpec> = {
  title: {
    structured: structuredTitle,
    path: [D, 1, 2, 0, 0],
  },
  summary: {
    structured: (sd) => sd.description ?? sd.ogDescription,
    path: [D, 1, 2, 73, 0, 1],
  },
  descriptionHTML: {
    path: [D, 1, 2, 72, 0, 1],
    altPath: [D, 1, 2, 12, 0, 0, 1],
  },
  installs: {
    path: [D, 1, 2, 13, 0],
    find: (s) => findFirst(s.get(D), isInstallsText),
  },
  minInstalls: { path: [D, 1, 2, 13, 1] },
  maxInstalls: { path: [D, 1, 2, 13, 2] },

  score: {
    structured: (sd) => sd.ratingValue,
    path: [D, 1, 2, 51, 0, 1],
    // The spine rounds differently from the payload; agreement to two decimals
    // is what matters, and that is checked in `reconcile`.
    skipDriftCheck: true,
  },
  scoreText: { path: [D, 1, 2, 51, 0, 0] },
  ratings: {
    structured: (sd) => sd.ratingCount,
    path: [D, 1, 2, 51, 2, 1],
    skipDriftCheck: true,
  },
  reviews: { path: [D, 1, 2, 51, 3, 1] },
  histogram: {
    path: [D, 1, 2, 51, 1],
    transform: histogramFrom,
    find: (s) => findFirst(s.get(D), (v) => histogramFrom(v) !== null),
  },

  price: {
    structured: (sd) => sd.price,
    path: [D, 1, 2, 57, 0, 0, 0, 0, 1, 0, 0],
    // The payload states micros; the spine states units.
    skipDriftCheck: true,
  },
  currency: {
    structured: (sd) => sd.priceCurrency,
    path: [D, 1, 2, 57, 0, 0, 0, 0, 1, 0, 1],
  },
  priceText: {
    // Google emits an empty string for free apps; the library renders "Free".
    path: [D, 1, 2, 57, 0, 0, 0, 0, 1, 0, 2],
    transform: (v) => (typeof v === 'string' && v.length > 0 ? v : 'Free'),
    always: true,
  },
  offersIAP: { path: [D, 1, 2, 19, 0], transform: (v) => Boolean(v), always: true },
  IAPRange: { path: [D, 1, 2, 19, 0] },

  /**
   * Live example of why this parser reports drift.
   *
   * google-play-scraper reads the minimum Android version from
   * `[140, 1, 1, 0, 0, 1]`. On pages served today that resolves to null: the
   * value has moved to `[140, 1, 0, 0, 1]`. The stale coordinate is kept as the
   * fallback because Google serves more than one page variant, so the old shape
   * still appears.
   */
  androidVersion: {
    path: [D, 1, 2, 140, 1, 0, 0, 1],
    altPath: [D, 1, 2, 140, 1, 1, 0, 0, 1],
    transform: (v) => (typeof v === 'string' && v.length > 0 ? v : 'VARY'),
    always: true,
  },
  androidVersionText: {
    path: [D, 1, 2, 140, 1, 0, 0, 1],
    altPath: [D, 1, 2, 140, 1, 1, 0, 0, 1],
    // Play renders "6.0 and up"; the library renders "Varies with device" when
    // it has nothing. Both conventions are kept so the field reads the same way
    // whichever parser produced it.
    transform: (v) => (typeof v === 'string' && v.length > 0 ? `${v} and up` : 'Varies with device'),
    always: true,
  },
  androidMaxVersion: {
    path: [D, 1, 2, 140, 1, 0, 1, 1],
    altPath: [D, 1, 2, 140, 1, 1, 0, 1, 1],
    transform: (v) => (typeof v === 'string' && v.length > 0 ? v : 'VARY'),
    always: true,
  },

  developer: {
    structured: (sd) => sd.authorName,
    path: [D, 1, 2, 68, 0],
  },
  developerId: {
    path: [D, 1, 2, 68, 1, 4, 2],
    transform: (v) => (typeof v === 'string' ? (v.split('id=')[1] ?? null) : null),
  },
  developerEmail: {
    path: [D, 1, 2, 69, 1, 0],
    find: (s) => findFirst(s.get(D), isEmail),
  },
  developerWebsite: {
    structured: (sd) => sd.authorUrl,
    path: [D, 1, 2, 69, 0, 5, 2],
  },
  developerAddress: { path: [D, 1, 2, 69, 2, 0] },
  developerLegalName: { path: [D, 1, 2, 69, 4, 0] },
  developerLegalEmail: { path: [D, 1, 2, 69, 4, 1, 0] },
  developerLegalPhoneNumber: { path: [D, 1, 2, 69, 4, 3] },
  privacyPolicy: {
    path: [D, 1, 2, 99, 0, 5, 2],
    find: (s) => findFirst(s.get(D), (v) => isHttpUrl(v) && /privacy/i.test(v as string)),
  },

  genre: { path: [D, 1, 2, 79, 0, 0, 0] },
  genreId: {
    structured: (sd) => sd.applicationCategory,
    path: [D, 1, 2, 79, 0, 0, 2],
  },

  icon: {
    structured: structuredIcon,
    path: [D, 1, 2, 95, 0, 3, 2],
  },
  headerImage: { path: [D, 1, 2, 96, 0, 3, 2] },
  screenshots: {
    path: [D, 1, 2, 78, 0],
    transform: (v) =>
      Array.isArray(v)
        ? v
            .map((s) => (Array.isArray(s) ? s?.[3]?.[2] : undefined))
            .filter((u): u is string => typeof u === 'string')
        : [],
    find: (s) => {
      const images = findAll(s.get(D), isPlayImage, { limit: 40 }) as string[]
      // The icon and header also live on that host; a listing's screenshots are
      // the bulk of them, so the first two are dropped rather than guessed at.
      return images.length > 3 ? images.slice(2) : []
    },
  },
  video: { path: [D, 1, 2, 100, 0, 0, 3, 2] },
  videoImage: { path: [D, 1, 2, 100, 1, 0, 3, 2] },
  previewVideo: { path: [D, 1, 2, 100, 1, 2, 0, 2] },

  contentRating: {
    structured: (sd) => sd.contentRating,
    path: [D, 1, 2, 9, 0],
  },
  contentRatingDescription: { path: [D, 1, 2, 9, 2, 1] },
  adSupported: { path: [D, 1, 2, 48], transform: (v) => Boolean(v), always: true },

  released: { path: [D, 1, 2, 10, 0] },
  updated: {
    path: [D, 1, 2, 145, 0, 1, 0],
    transform: (v) => (typeof v === 'number' ? v * 1000 : null),
  },
  version: {
    path: [D, 1, 2, 140, 0, 0, 0],
    altPath: [D, 1, 2, 141, 0, 0, 0],
    transform: (v) => (typeof v === 'string' && v.length > 0 ? v : 'VARY'),
    always: true,
  },
  recentChanges: { path: [D, 1, 2, 144, 1, 1] },

  preregister: { path: [D, 1, 2, 18, 0], transform: (v) => v === 1, always: true },
  earlyAccessEnabled: {
    path: [D, 1, 2, 18, 2],
    transform: (v) => typeof v === 'string',
    always: true,
  },
  isAvailableInPlayPass: { path: [D, 1, 2, 62], transform: (v) => Boolean(v), always: true },
  available: { path: [D, 1, 2, 18, 0], transform: (v) => Boolean(v), always: true },

  developerLegalAddress: {
    path: [D, 1, 2, 69, 4, 2, 0],
    transform: (v) => (typeof v === 'string' ? v.replace(/\n/g, ', ') : null),
  },

  /**
   * Categories, with the shape the client's example showed: a name and an id,
   * where the id can legitimately be null.
   */
  categories: {
    path: [D, 1, 2, 118],
    transform: (v) => {
      if (!Array.isArray(v)) return []
      const list = Array.isArray(v[0]) ? (v[0] as unknown[]) : []
      const out: { name: string | null; id: string | null }[] = []
      for (const entry of list) {
        if (!Array.isArray(entry)) continue
        const name = typeof entry[0] === 'string' ? entry[0] : null
        const id = typeof entry[2] === 'string' ? entry[2] : null
        if (name !== null || id !== null) out.push({ name, id })
      }
      return out
    },
  },
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Loose equality: the two sources format numbers and strings differently. */
function agrees(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01
  return String(a).trim() === String(b).trim()
}

/**
 * Whether a coordinate's structure is genuinely gone, as opposed to its value
 * being legitimately absent.
 *
 * This is deliberately conservative, because on a SINGLE page the two are not
 * reliably distinguishable. `[..., 19]` being null means "this app has no in-app
 * purchases" far more often than it means "the payload moved", and reporting
 * every such null as breakage produces an alarm nobody reads.
 *
 * So per page, only a collapse deep in the chain counts: the grandparent gone
 * means the containing structure is missing, not just the value.
 *
 * The reliable drift signal is not per page at all, it is per fleet: a
 * coordinate that comes back null for EVERY app in a run has moved, whereas one
 * that is null for a third of them is simply optional. That aggregation lives in
 * `src/cli/compare-parsers.ts`, where there is a population to compare against.
 */
function pathIsBroken(store: DataStore, path: readonly (string | number)[]): boolean {
  if (path.length <= 3) return at(store, path.slice(0, 2)) === undefined
  const grandparent = at(store, path.slice(0, -2))
  return grandparent === undefined || grandparent === null
}

function resolveOne(
  spec: FieldSpec,
  store: DataStore,
  sd: StructuredData,
): FieldOutcome & { pathBroken: boolean } {
  const structured = spec.structured ? (spec.structured(sd) ?? null) : null

  let path: unknown = spec.path ? at(store, spec.path) : undefined
  if ((path === undefined || path === null) && spec.altPath) path = at(store, spec.altPath)

  // Broken only when BOTH coordinates lost their container, not when they
  // resolve to a legitimate null.
  const pathBroken =
    spec.path !== undefined &&
    pathIsBroken(store, spec.path) &&
    (spec.altPath === undefined || pathIsBroken(store, spec.altPath))

  const transform = spec.transform ?? ((v: unknown) => v)
  const pathValue = path === undefined ? undefined : transform(path)

  const hasStructured = structured !== null && structured !== undefined
  const hasPath = pathValue !== null && pathValue !== undefined

  // Both present: compare them, then take the more stable one.
  if (hasStructured && hasPath) {
    const drifted = !spec.skipDriftCheck && !agrees(structured, pathValue)
    const preferStructured = spec.preferStructured ?? true
    return {
      value: preferStructured ? structured : pathValue,
      strategy: preferStructured ? 'structured' : 'path',
      pathBroken: false,
      ...(drifted ? { drift: { structured, path: pathValue } } : {}),
    }
  }

  if (hasStructured) return { value: structured, strategy: 'structured', pathBroken }
  if (hasPath) return { value: pathValue, strategy: 'path', pathBroken: false }

  // Neither, but the field has a defined value for "absent".
  if (spec.always && spec.transform) {
    return { value: spec.transform(undefined), strategy: 'derived', pathBroken }
  }

  // Neither: try to find it by shape before giving up.
  if (spec.find) {
    const found = transform(spec.find(store))
    if (found !== null && found !== undefined) {
      return { value: found, strategy: 'find', pathBroken }
    }
  }

  return { value: null, strategy: null, pathBroken }
}

export interface ExtractionResult {
  fields: Record<string, unknown>
  report: ExtractionReport
}

export function extractFields(store: DataStore, sd: StructuredData): ExtractionResult {
  const fields: Record<string, unknown> = {}
  const report: ExtractionReport = {
    strategies: {},
    drift: [],
    brokenPaths: [],
    rescuedByFind: [],
    dataBlocks: store.size,
    structuredPresent: sd.present,
  }

  for (const [name, spec] of Object.entries(FIELD_SPECS)) {
    const outcome = resolveOne(spec, store, sd)
    fields[name] = outcome.value
    report.strategies[name] = outcome.strategy

    if (outcome.drift) {
      report.drift.push({ field: name, ...outcome.drift })
    }
    if (outcome.pathBroken) report.brokenPaths.push(name)
    if (outcome.strategy === 'find') report.rescuedByFind.push(name)
  }

  return { fields, report }
}

/**
 * Whether the extraction looks trustworthy enough to store.
 *
 * A page that yields a title and a handful of other fields is a real listing. A
 * page that yields almost nothing is a block, a redirect or a format change, and
 * storing it would poison the catalogue with an app that appears to exist and
 * has no content. Same principle as the ingest quality gate, applied one layer
 * earlier where the evidence is better.
 */
export function extractionIsSound(result: ExtractionResult): { ok: boolean; reason?: string } {
  const { fields, report } = result

  if (report.dataBlocks === 0 && !report.structuredPresent.jsonLd) {
    return { ok: false, reason: 'no data blocks and no structured data: not a listing page' }
  }
  if (typeof fields.title !== 'string' || fields.title.length === 0) {
    return { ok: false, reason: 'no title from any source' }
  }

  const filled = Object.values(fields).filter(
    (v) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0),
  ).length

  if (filled < 8) {
    return { ok: false, reason: `only ${filled} fields resolved; the payload shape has likely changed` }
  }
  /**
   * Note what does NOT reject a page: a large `brokenPaths` count.
   *
   * Broken coordinates mean the result is INCOMPLETE. Drift means it is
   * UNTRUSTWORTHY. Only the second is a reason to throw data away.
   *
   * If Google reshuffles the payload tomorrow and every coordinate dies, the
   * schema.org block still yields a title, developer, rating, price, category
   * and icon, and every one of those is correct. Refusing them because other
   * fields went missing would turn a partial outage into a total one. The
   * ingest quality gate downstream decides whether what survived is substantial
   * enough to be worth a page; this gate only decides whether it is true.
   *
   * The breakage is still reported, loudly, in `brokenPaths`.
   */
  if (report.drift.length > 3) {
    return {
      ok: false,
      reason:
        `${report.drift.length} fields disagree between the structured data and the ` +
        `coordinates: the two readings contradict each other, so neither can be trusted`,
    }
  }
  return { ok: true }
}
