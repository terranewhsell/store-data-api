/**
 * The canonical contract.
 *
 * `CANONICAL_FIELDS` is the exact field list the client supplied, in the order
 * they supplied it. It is the source of truth for the whole service: the
 * normalizers build against it, the tests compare against it, and every response
 * carries every one of these keys for every source.
 *
 * Rules that are not negotiable:
 *
 *  - A key is NEVER omitted. Absent data is `null`, present at the top level.
 *    That is what lets a Flutter model or an Astro component type the payload
 *    once instead of guarding every field.
 *  - `undefined` does not exist in JSON. The client's example is JavaScript and
 *    contains `undefined` for several fields; those are served as `null`. There
 *    is no other faithful translation, and it is stated explicitly rather than
 *    left to be discovered.
 *  - Nothing is invented. A field the source does not provide stays null and is
 *    accounted for in `_meta.fieldCoverage`; it is never defaulted to a
 *    plausible-looking value.
 */

export const SOURCES = ['play', 'ios', 'steam'] as const
export type Source = (typeof SOURCES)[number]

export type AppType = 'app' | 'game'

export interface CategoryRef {
  name: string | null
  id: string | null
}

export interface FeatureRef {
  title: string | null
  description: string | null
}

export type Histogram = Record<'1' | '2' | '3' | '4' | '5', number>

/**
 * The flat core. Field for field, name for name, what the client asked for.
 * `isAvailableInPlayPass` appears once; it was listed twice in the original
 * message.
 */
export interface CanonicalApp {
  title: string | null
  description: string | null
  descriptionHTML: string | null
  summary: string | null
  installs: string | null
  minInstalls: number | null
  maxInstalls: number | null
  score: number | null
  scoreText: string | null
  ratings: number | null
  reviews: number | null
  histogram: Histogram | null
  price: number | null
  free: boolean | null
  currency: string | null
  priceText: string | null
  offersIAP: boolean | null
  IAPRange: string | null
  androidVersion: string | null
  androidVersionText: string | null
  androidMaxVersion: string | null
  developer: string | null
  developerId: string | null
  developerEmail: string | null
  developerWebsite: string | null
  developerAddress: string | null
  developerLegalName: string | null
  developerLegalEmail: string | null
  developerLegalAddress: string | null
  developerLegalPhoneNumber: string | null
  privacyPolicy: string | null
  developerInternalID: string | null
  genre: string | null
  genreId: string | null
  categories: CategoryRef[]
  icon: string | null
  headerImage: string | null
  screenshots: string[]
  video: string | null
  videoImage: string | null
  previewVideo: string | null
  contentRating: string | null
  contentRatingDescription: string | null
  adSupported: boolean | null
  released: string | null
  updated: number | null
  version: string | null
  recentChanges: string | null
  comments: string[]
  preregister: boolean | null
  earlyAccessEnabled: boolean | null
  isAvailableInPlayPass: boolean | null
  editorsChoice: boolean | null
  features: FeatureRef[]
  appId: string | null
  iosId: string | null
  url: string | null
  type: AppType
}

/** Declared once, used by the normalizers and asserted by the contract test. */
export const CANONICAL_FIELDS = [
  'title',
  'description',
  'descriptionHTML',
  'summary',
  'installs',
  'minInstalls',
  'maxInstalls',
  'score',
  'scoreText',
  'ratings',
  'reviews',
  'histogram',
  'price',
  'free',
  'currency',
  'priceText',
  'offersIAP',
  'IAPRange',
  'androidVersion',
  'androidVersionText',
  'androidMaxVersion',
  'developer',
  'developerId',
  'developerEmail',
  'developerWebsite',
  'developerAddress',
  'developerLegalName',
  'developerLegalEmail',
  'developerLegalAddress',
  'developerLegalPhoneNumber',
  'privacyPolicy',
  'developerInternalID',
  'genre',
  'genreId',
  'categories',
  'icon',
  'headerImage',
  'screenshots',
  'video',
  'videoImage',
  'previewVideo',
  'contentRating',
  'contentRatingDescription',
  'adSupported',
  'released',
  'updated',
  'version',
  'recentChanges',
  'comments',
  'preregister',
  'earlyAccessEnabled',
  'isAvailableInPlayPass',
  'editorsChoice',
  'features',
  'appId',
  'iosId',
  'url',
  'type',
] as const satisfies readonly (keyof CanonicalApp)[]

export type CanonicalField = (typeof CANONICAL_FIELDS)[number]

/** A blank canonical object: every key present, every value null or empty. */
export function emptyCanonical(): CanonicalApp {
  return {
    title: null,
    description: null,
    descriptionHTML: null,
    summary: null,
    installs: null,
    minInstalls: null,
    maxInstalls: null,
    score: null,
    scoreText: null,
    ratings: null,
    reviews: null,
    histogram: null,
    price: null,
    free: null,
    currency: null,
    priceText: null,
    offersIAP: null,
    IAPRange: null,
    androidVersion: null,
    androidVersionText: null,
    androidMaxVersion: null,
    developer: null,
    developerId: null,
    developerEmail: null,
    developerWebsite: null,
    developerAddress: null,
    developerLegalName: null,
    developerLegalEmail: null,
    developerLegalAddress: null,
    developerLegalPhoneNumber: null,
    privacyPolicy: null,
    developerInternalID: null,
    genre: null,
    genreId: null,
    categories: [],
    icon: null,
    headerImage: null,
    screenshots: [],
    video: null,
    videoImage: null,
    previewVideo: null,
    contentRating: null,
    contentRatingDescription: null,
    adSupported: null,
    released: null,
    updated: null,
    version: null,
    recentChanges: null,
    comments: [],
    preregister: null,
    earlyAccessEnabled: null,
    isAvailableInPlayPass: null,
    editorsChoice: null,
    features: [],
    appId: null,
    iosId: null,
    url: null,
    type: 'app',
  }
}

/**
 * Why a canonical field is null.
 *   not_applicable - the source has no such concept. `androidVersion` on Steam.
 *   not_available  - the concept exists but we could not obtain the value.
 *
 * Without this distinction a consumer cannot tell a missing feature from a
 * missing fetch, which is the most common complaint about any multi-source API.
 */
export type CoverageReason = 'not_applicable' | 'not_available'
export type FieldCoverage = Partial<Record<CanonicalField, CoverageReason>>

/**
 * Fields we computed rather than read.
 *
 * Steam publishes a positive/negative review split, not a five-star average, so a
 * `score` for a Steam game is a transformation of a real number and not a
 * reported one. Serving it without saying so would be dishonest; withholding it
 * would make Steam games unsortable next to the other two sources. So it is
 * served, with the formula attached.
 *
 * A per-star `histogram` is NOT derived: there is no real per-star data behind
 * it, and a plausible-looking invented histogram is exactly the kind of quiet
 * fiction that gets believed.
 */
export type DerivedFields = Partial<Record<CanonicalField, string>>

export interface MatchInfo {
  /** 0..1. How sure we are that the App Store cross-link is the same product. */
  confidence: number
  /** How it was established, so a bad heuristic can be found and fixed later. */
  method: string
}

export interface ResponseMeta {
  source: Source
  sourceId: string
  market: { country: string; lang: string }
  /** The market actually served, when it differs from the one requested. */
  servedMarket?: { country: string; lang: string }
  marketFallback?: boolean
  fetchedAt: string
  ageSeconds: number
  /** ISO timestamp of the last time the content actually changed. */
  lastChangedAt: string
  schemaVersion: string
  status: 'active' | 'delisted' | 'unknown'
  delistedAt?: string | null
  fieldCoverage: FieldCoverage
  derivedFields: DerivedFields
  iosMatch?: MatchInfo
}

/** Source-specific data that has no place in a Play-shaped schema. */
export interface ExtraBlock {
  play?: Record<string, unknown>
  ios?: Record<string, unknown>
  steam?: Record<string, unknown>
}

/**
 * What a route returns for one app: the canonical core at the top level, plus
 * `slug`, `extra` and `_meta` as siblings. Purely additive, so a consumer written
 * against the client's original object keeps working untouched.
 */
export type AppResource = CanonicalApp & {
  /** Permanent URL segment. Generated once, never recomputed. */
  slug: string
  extra: ExtraBlock
  _meta: ResponseMeta
}

export const SCHEMA_VERSION = '1.0.0'

/** Normalized shape produced by every source adapter before it is stored. */
export interface NormalizedApp {
  core: CanonicalApp
  extra: ExtraBlock
  coverage: FieldCoverage
  derived: DerivedFields
  source: Source
  sourceId: string
  country: string
  lang: string
  /** Text fed to the local search index: title, developer, summary, description. */
  searchText: string
}
