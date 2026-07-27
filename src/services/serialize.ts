/**
 * Row -> API resource.
 *
 * The canonical core is stored exactly as it is served, so this is assembly, not
 * transformation. What gets added here is the part that only makes sense at read
 * time: how old the data is, which market actually answered, and whether a null
 * is a missing feature or a missing fetch.
 *
 * `assembleCore` is the guard that makes the contract true rather than intended:
 * it walks CANONICAL_FIELDS and writes every one of them, so a field added to the
 * contract can never be silently absent from a response just because an old row
 * predates it.
 */
import {
  CANONICAL_FIELDS,
  emptyCanonical,
  emptyCommon,
  SCHEMA_VERSION,
  type AppResource,
  type CanonicalApp,
  type CommonBlock,
  type DerivedFields,
  type ExtraBlock,
  type FieldCoverage,
  type RankingPosition,
  type ResponseMeta,
  type Source,
} from '../normalize/contract.ts'
import { attachRankings } from '../normalize/common.ts'

export interface LocaleRowLike {
  core: unknown
  common?: unknown
  extra: unknown
  coverage: unknown
  country: string
  lang: string
  source: string
  sourceId: string
  fetchedAt: Date
  lastChangedAt: Date
}

export interface AppRowLike {
  slug: string
  status: string
  delistedAt: Date | null
  iosId: string | null
  iosMatchConfidence: number | null
  iosMatchMethod: string | null
}

export interface SerializeOptions {
  /** The market the caller asked for, when it differs from the one we served. */
  requestedMarket?: { country: string; lang: string }
  /**
   * Chart placements for this app, joined in by the caller.
   *
   * Not stored on the listing: a ranking belongs to the chart and changes on the
   * chart's schedule, so baking it into the row would make every listing stale
   * every time any chart refreshed.
   */
  rankings?: RankingPosition[]
  now?: Date
}

/**
 * Rebuilds the core with every canonical key present, whatever the stored row
 * happens to contain. Absent keys become their empty value; unknown stored keys
 * are dropped. Both directions matter: the first keeps the contract stable across
 * schema changes, the second stops a source field leaking into the core.
 */
export function assembleCore(stored: unknown): CanonicalApp {
  const base = emptyCanonical()
  if (stored === null || typeof stored !== 'object') return base

  const record = stored as Record<string, unknown>
  const out = base as unknown as Record<string, unknown>

  for (const field of CANONICAL_FIELDS) {
    const value = record[field]
    if (value === undefined) continue
    // `undefined` in, `null` out. JSON has no undefined and the contract says so.
    out[field] = value === undefined ? null : value
  }
  return out as unknown as CanonicalApp
}

interface StoredCoverage {
  fieldCoverage?: FieldCoverage
  derivedFields?: DerivedFields
}

function splitCoverage(stored: unknown): StoredCoverage {
  if (stored === null || typeof stored !== 'object') return {}
  const record = stored as Record<string, unknown>
  // Rows written before derivedFields existed stored the coverage map directly.
  if ('fieldCoverage' in record || 'derivedFields' in record) {
    return {
      fieldCoverage: (record.fieldCoverage ?? {}) as FieldCoverage,
      derivedFields: (record.derivedFields ?? {}) as DerivedFields,
    }
  }
  return { fieldCoverage: record as FieldCoverage, derivedFields: {} }
}

export function serializeApp(
  appRow: AppRowLike,
  localeRow: LocaleRowLike,
  opts: SerializeOptions = {},
): AppResource {
  const now = opts.now ?? new Date()
  const core = assembleCore(localeRow.core)
  const { fieldCoverage, derivedFields } = splitCoverage(localeRow.coverage)

  const servedMarket = { country: localeRow.country, lang: localeRow.lang }
  const requested = opts.requestedMarket ?? servedMarket
  const fellBack =
    requested.country !== servedMarket.country || requested.lang !== servedMarket.lang

  const meta: ResponseMeta = {
    source: localeRow.source as Source,
    sourceId: localeRow.sourceId,
    market: requested,
    fetchedAt: localeRow.fetchedAt.toISOString(),
    ageSeconds: Math.max(0, Math.floor((now.getTime() - localeRow.fetchedAt.getTime()) / 1000)),
    lastChangedAt: localeRow.lastChangedAt.toISOString(),
    schemaVersion: SCHEMA_VERSION,
    status: (appRow.status as ResponseMeta['status']) ?? 'unknown',
    delistedAt: appRow.delistedAt ? appRow.delistedAt.toISOString() : null,
    fieldCoverage: fieldCoverage ?? {},
    derivedFields: derivedFields ?? {},
  }

  if (fellBack) {
    meta.servedMarket = servedMarket
    meta.marketFallback = true
  }

  if (appRow.iosId && appRow.iosMatchConfidence !== null) {
    meta.iosMatch = {
      confidence: appRow.iosMatchConfidence,
      method: appRow.iosMatchMethod ?? 'unknown',
    }
  }

  // The stored core carries the cross-link that was known when it was written;
  // the apps row is the current truth, so it wins.
  if (appRow.iosId) core.iosId = appRow.iosId

  const extra = (localeRow.extra ?? {}) as ExtraBlock

  // Rows written before `common` existed deserialise to an empty block rather
  // than a missing key, so the shape is stable across a schema change.
  const storedCommon =
    localeRow.common && typeof localeRow.common === 'object'
      ? { ...emptyCommon(), ...(localeRow.common as Partial<CommonBlock>) }
      : emptyCommon()

  const common = attachRankings(storedCommon, opts.rankings ?? [])

  return {
    ...core,
    slug: appRow.slug,
    common,
    extra,
    _meta: meta,
  }
}

/** Compact form for list responses: identity, imagery and the headline numbers. */
export interface AppSummary {
  slug: string
  appId: string | null
  iosId: string | null
  title: string | null
  summary: string | null
  developer: string | null
  icon: string | null
  score: number | null
  scoreText: string | null
  ratings: number | null
  price: number | null
  free: boolean | null
  priceText: string | null
  genre: string | null
  genreId: string | null
  type: string
  url: string | null
  /**
   * Best current chart placement, or null when the app is in no chart.
   *
   * Included in the compact form on purpose: for an App Store listing this is
   * the only popularity signal that exists, because Apple publishes no install
   * counts anywhere.
   */
  bestRank: RankingPosition | null
  _meta: Pick<ResponseMeta, 'source' | 'sourceId' | 'market' | 'fetchedAt' | 'ageSeconds' | 'status'>
}

export function serializeSummary(
  appRow: AppRowLike,
  localeRow: LocaleRowLike,
  opts: SerializeOptions = {},
): AppSummary {
  const now = opts.now ?? new Date()
  const core = assembleCore(localeRow.core)
  return {
    slug: appRow.slug,
    appId: core.appId,
    iosId: appRow.iosId ?? core.iosId,
    title: core.title,
    summary: core.summary,
    developer: core.developer,
    icon: core.icon,
    score: core.score,
    scoreText: core.scoreText,
    ratings: core.ratings,
    price: core.price,
    free: core.free,
    priceText: core.priceText,
    genre: core.genre,
    genreId: core.genreId,
    type: core.type,
    url: core.url,
    bestRank:
      (opts.rankings ?? []).slice().sort((a, b) => a.position - b.position)[0] ?? null,
    _meta: {
      source: localeRow.source as Source,
      sourceId: localeRow.sourceId,
      market: { country: localeRow.country, lang: localeRow.lang },
      fetchedAt: localeRow.fetchedAt.toISOString(),
      ageSeconds: Math.max(0, Math.floor((now.getTime() - localeRow.fetchedAt.getTime()) / 1000)),
      status: (appRow.status as ResponseMeta['status']) ?? 'unknown',
    },
  }
}
