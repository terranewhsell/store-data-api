/**
 * Google Play -> canonical.
 *
 * The shortest of the three, on purpose: the canonical contract IS the Play
 * shape, because the client's example was this library's output. So this module
 * mostly coerces `undefined` to `null`, decodes HTML entities in text, adds the
 * two fields the client invented (`type`, `iosId`), and files anything the
 * contract has no home for under `extra.play`.
 */
import {
  CANONICAL_FIELDS,
  emptyCanonical,
  type CanonicalApp,
  type CategoryRef,
  type Histogram,
  type NormalizedApp,
} from './contract.ts'
import { completeCoverage } from './coverage.ts'
import {
  bool,
  buildSearchText,
  deriveTypeFromPlay,
  html,
  int,
  num,
  str,
  strArray,
} from './shared.ts'

/** Fields the library returns that the canonical contract does not carry. */
const EXTRA_KEYS = ['originalPrice', 'discountEndDate', 'available', 'installsText'] as const

function toCategories(value: unknown): CategoryRef[] {
  if (!Array.isArray(value)) return []
  const out: CategoryRef[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const name = str(record.name)
    const id = str(record.id)
    if (name === null && id === null) continue
    out.push({ name, id })
  }
  return out
}

/**
 * Play returns the histogram as `{1: n, ..., 5: n}`. A partial histogram is
 * discarded rather than padded: five buckets where two were real would be a
 * fabrication in the same shape as the truth.
 */
function toHistogram(value: unknown): Histogram | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const keys = ['1', '2', '3', '4', '5'] as const
  const out = {} as Histogram
  for (const key of keys) {
    const n = int(record[key])
    if (n === null) return null
    out[key] = n
  }
  return out
}

export interface PlayNormalizeOptions {
  country: string
  lang: string
  /** Cross-link resolved elsewhere; null when unmatched or unreliable. */
  iosId?: string | null
}

export function normalizePlayApp(
  raw: Record<string, unknown>,
  opts: PlayNormalizeOptions,
): NormalizedApp {
  const core: CanonicalApp = emptyCanonical()

  core.title = str(raw.title)
  core.description = str(raw.description)
  core.descriptionHTML = html(raw.descriptionHTML)
  core.summary = str(raw.summary)
  core.installs = str(raw.installs)
  core.minInstalls = int(raw.minInstalls)
  core.maxInstalls = int(raw.maxInstalls)
  core.score = num(raw.score)
  core.scoreText = str(raw.scoreText)
  core.ratings = int(raw.ratings)
  core.reviews = int(raw.reviews)
  core.histogram = toHistogram(raw.histogram)
  core.price = num(raw.price)
  core.free = bool(raw.free)
  core.currency = str(raw.currency)
  core.priceText = str(raw.priceText)
  core.offersIAP = bool(raw.offersIAP)
  core.IAPRange = str(raw.IAPRange)
  core.androidVersion = str(raw.androidVersion)
  core.androidVersionText = str(raw.androidVersionText)
  core.androidMaxVersion = str(raw.androidMaxVersion)
  core.developer = str(raw.developer)
  core.developerId = str(raw.developerId)
  core.developerEmail = str(raw.developerEmail)
  core.developerWebsite = str(raw.developerWebsite)
  core.developerAddress = str(raw.developerAddress)
  core.developerLegalName = str(raw.developerLegalName)
  core.developerLegalEmail = str(raw.developerLegalEmail)
  core.developerLegalAddress = str(raw.developerLegalAddress)
  core.developerLegalPhoneNumber = str(raw.developerLegalPhoneNumber)
  core.privacyPolicy = str(raw.privacyPolicy)
  core.developerInternalID = str(raw.developerInternalID)
  core.genre = str(raw.genre)
  core.genreId = str(raw.genreId)
  core.categories = toCategories(raw.categories)
  core.icon = str(raw.icon)
  core.headerImage = str(raw.headerImage)
  core.screenshots = strArray(raw.screenshots)
  core.video = str(raw.video)
  core.videoImage = str(raw.videoImage)
  core.previewVideo = str(raw.previewVideo)
  core.contentRating = str(raw.contentRating)
  core.contentRatingDescription = str(raw.contentRatingDescription)
  core.adSupported = bool(raw.adSupported)
  core.released = str(raw.released)
  core.updated = int(raw.updated)
  core.version = str(raw.version)
  core.recentChanges = str(raw.recentChanges)
  core.comments = strArray(raw.comments)
  core.preregister = bool(raw.preregister)
  core.earlyAccessEnabled = bool(raw.earlyAccessEnabled)
  core.isAvailableInPlayPass = bool(raw.isAvailableInPlayPass)

  // Present in the client's example, not produced by the current library
  // version. Explicitly null, and explained in the coverage matrix.
  core.editorsChoice = bool(raw.editorsChoice)
  core.features = []

  core.appId = str(raw.appId)
  core.iosId = opts.iosId ?? null
  core.url =
    str(raw.url) ??
    (core.appId
      ? `https://play.google.com/store/apps/details?id=${core.appId}&hl=${opts.lang}&gl=${opts.country}`
      : null)
  core.type = deriveTypeFromPlay(core.genreId, core.categories)

  const extra: Record<string, unknown> = {}
  for (const key of EXTRA_KEYS) {
    if (raw[key] !== undefined) extra[key] = raw[key]
  }

  return {
    core,
    extra: Object.keys(extra).length > 0 ? { play: extra } : {},
    coverage: completeCoverage('play', core as unknown as Record<string, unknown>, CANONICAL_FIELDS),
    derived: {},
    source: 'play',
    sourceId: core.appId ?? '',
    country: opts.country,
    lang: opts.lang,
    searchText: buildSearchText(core),
  }
}
