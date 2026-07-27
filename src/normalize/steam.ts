/**
 * Steam -> canonical.
 *
 * The interesting decisions are all about not lying.
 *
 * `histogram` is null. Steam publishes a positive/negative split, not a per-star
 * breakdown, and turning two numbers into five would produce something shaped
 * exactly like real data and believed accordingly. The brief says not to simulate
 * it, and it is not simulated.
 *
 * `score` IS provided, from the positive ratio scaled to five, because otherwise
 * Steam games cannot be ordered alongside the other two sources at all. It is
 * marked in `_meta.derivedFields` with the formula that produced it, so nobody
 * has to guess whether it is a reported average or a computed one. The untouched
 * Steam numbers are all in `extra.steam`.
 *
 * `offersIAP` is likewise derived, from the presence of Steam's "In-App
 * Purchases" store category, and marked the same way.
 */
import type { SteamAppDetails, SteamReviewSummary } from '../sources/steam.ts'
import {
  CANONICAL_FIELDS,
  emptyCanonical,
  type CanonicalApp,
  type CategoryRef,
  type DerivedFields,
  type NormalizedApp,
} from './contract.ts'
import { completeCoverage } from './coverage.ts'
import {
  bool,
  buildSearchText,
  deriveTypeFromSteam,
  html,
  int,
  scoreToText,
  str,
  toPlainTextSafe,
} from './shared.ts'

/** Steam's store category id for in-app purchases. */
const IAP_CATEGORY_ID = 35

function toCategories(details: SteamAppDetails): CategoryRef[] {
  // Steam's `genres` are the closest analogue to Play's categories: a small,
  // stable taxonomy describing what the thing is. Its `categories` field is a
  // feature list (Single-player, Cloud Saves) and belongs in `extra`, not here.
  const genres = Array.isArray(details.genres) ? (details.genres as unknown[]) : []
  const out: CategoryRef[] = []
  for (const entry of genres) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const name = str(record.description)
    const id = str(record.id)
    if (name === null && id === null) continue
    out.push({ name, id })
  }
  return out
}

function screenshots(details: SteamAppDetails): string[] {
  const list = Array.isArray(details.screenshots) ? (details.screenshots as unknown[]) : []
  const out: string[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const url = str(record.path_full) ?? str(record.path_thumbnail)
    if (url) out.push(url)
  }
  return out
}

function movies(details: SteamAppDetails): { video: string | null; videoImage: string | null } {
  const list = Array.isArray(details.movies) ? (details.movies as unknown[]) : []
  const first = list[0]
  if (first === undefined || first === null || typeof first !== 'object') {
    return { video: null, videoImage: null }
  }
  const record = first as Record<string, unknown>
  const mp4 = record.mp4 as Record<string, unknown> | undefined
  const webm = record.webm as Record<string, unknown> | undefined
  const video = str(mp4?.max) ?? str(mp4?.['480']) ?? str(webm?.max) ?? str(webm?.['480'])
  return { video, videoImage: str(record.thumbnail) }
}

function hasIapCategory(details: SteamAppDetails): boolean | null {
  const list = Array.isArray(details.categories) ? (details.categories as unknown[]) : null
  if (list === null) return null
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = int((entry as Record<string, unknown>).id)
    if (id === IAP_CATEGORY_ID) return true
  }
  return false
}

/** Steam's price_overview reports minor units: 1999 means 19.99. */
function price(details: SteamAppDetails): {
  price: number | null
  currency: string | null
  priceText: string | null
  free: boolean | null
} {
  if (details.is_free === true) {
    return { price: 0, currency: null, priceText: 'Free', free: true }
  }
  const overview = details.price_overview as Record<string, unknown> | undefined
  if (overview === undefined || overview === null) {
    return { price: null, currency: null, priceText: null, free: null }
  }
  const final = int(overview.final)
  return {
    price: final === null ? null : final / 100,
    currency: str(overview.currency),
    priceText: str(overview.final_formatted),
    free: final === null ? null : final === 0,
  }
}

function contentRating(details: SteamAppDetails): string | null {
  const ratings = details.ratings as Record<string, unknown> | undefined
  if (ratings) {
    for (const board of ['esrb', 'pegi', 'usk', 'cero', 'dejus']) {
      const entry = ratings[board] as Record<string, unknown> | undefined
      const rating = str(entry?.rating)
      if (rating) return `${board.toUpperCase()} ${rating}`
    }
  }
  const requiredAge = int(details.required_age)
  if (requiredAge !== null && requiredAge > 0) return `${requiredAge}+`
  return null
}

export interface SteamNormalizeOptions {
  country: string
  lang: string
  reviews?: SteamReviewSummary | null
}

export function normalizeSteamApp(
  details: SteamAppDetails,
  opts: SteamNormalizeOptions,
): NormalizedApp {
  const core: CanonicalApp = emptyCanonical()
  const derived: DerivedFields = {}

  const appId = String(details.steam_appid)
  const reviews = opts.reviews ?? null

  core.title = str(details.name)
  core.descriptionHTML = html(details.detailed_description)
  core.description = toPlainTextSafe(details.detailed_description)
  core.summary = str(details.short_description)

  // Ratings. `ratings` is the real total review count; `reviews` is the same
  // number because on Steam every review is a written review, unlike the stores
  // where a star rating and a written review are different acts.
  if (reviews) {
    core.ratings = reviews.totalReviews
    core.reviews = reviews.totalReviews

    const positive = reviews.totalPositive
    const total = reviews.totalReviews
    if (positive !== null && total !== null && total > 0) {
      core.score = Number(((positive / total) * 5).toFixed(4))
      core.scoreText = scoreToText(core.score)
      derived.score = 'total_positive / total_reviews * 5 (Steam publishes no star average)'
      derived.scoreText = 'formatted from the derived score'
    }
  }
  // Never derived: there is no per-star data behind it.
  core.histogram = null

  const p = price(details)
  core.price = p.price
  core.currency = p.currency
  core.priceText = p.priceText
  core.free = p.free

  const iap = hasIapCategory(details)
  if (iap !== null) {
    core.offersIAP = iap
    derived.offersIAP = 'presence of Steam store category 35 (In-App Purchases)'
  }

  const developers = Array.isArray(details.developers) ? (details.developers as unknown[]) : []
  core.developer = str(developers[0])
  core.developerWebsite = str(details.website)

  const categories = toCategories(details)
  core.categories = categories
  core.genre = categories[0]?.name ?? null
  core.genreId = categories[0]?.id ?? null

  core.icon = str(details.capsule_image) ?? str(details.capsule_imagev5)
  core.headerImage = str(details.header_image)
  core.screenshots = screenshots(details)

  const m = movies(details)
  core.video = m.video
  core.videoImage = m.videoImage
  core.previewVideo = m.video

  core.contentRating = contentRating(details)

  const releaseDate = details.release_date as Record<string, unknown> | undefined
  core.released = str(releaseDate?.date)
  // Steam's "coming soon" flag is the closest thing it has to a pre-release
  // state, but it is not Play's pre-registration mechanic, so it is not mapped
  // onto `preregister`. It is preserved untouched in extra.steam.
  core.earlyAccessEnabled = categories.some((c) => (c.name ?? '').toLowerCase() === 'early access')

  core.appId = appId
  core.url = `https://store.steampowered.com/app/${appId}/?cc=${opts.country}&l=${opts.lang}`
  core.type = deriveTypeFromSteam(str(details.type))

  const steamCategories = Array.isArray(details.categories)
    ? (details.categories as Record<string, unknown>[]).map((c) => ({
        id: int(c.id),
        description: str(c.description),
      }))
    : []

  const extra: Record<string, unknown> = {
    steamAppId: appId,
    steamType: str(details.type),
    isFree: bool(details.is_free),
    requiredAge: int(details.required_age),
    comingSoon: bool(releaseDate?.coming_soon),
    developers: developers.map((d) => str(d)).filter((d): d is string => d !== null),
    publishers: Array.isArray(details.publishers)
      ? (details.publishers as unknown[]).map((p2) => str(p2)).filter((p2): p2 is string => p2 !== null)
      : [],
    // Steam's own feature list: Single-player, Steam Achievements, Cloud Saves.
    categories: steamCategories,
    genres: categories,
    metacritic: details.metacritic ?? null,
    platforms: details.platforms ?? null,
    dlc: Array.isArray(details.dlc) ? details.dlc : [],
    achievements: details.achievements ?? null,
    controllerSupport: str(details.controller_support),
    supportInfo: details.support_info ?? null,
    pcRequirements: details.pc_requirements ?? null,
    recommendations: details.recommendations ?? null,
    priceOverview: details.price_overview ?? null,
    // The real review numbers, untouched, next to the derived score.
    reviewSummary: reviews
      ? {
          reviewScore: reviews.reviewScore,
          reviewScoreDesc: reviews.reviewScoreDesc,
          totalPositive: reviews.totalPositive,
          totalNegative: reviews.totalNegative,
          totalReviews: reviews.totalReviews,
        }
      : null,
  }

  return {
    core,
    extra: { steam: extra },
    coverage: completeCoverage('steam', core as unknown as Record<string, unknown>, CANONICAL_FIELDS),
    derived,
    source: 'steam',
    sourceId: appId,
    country: opts.country,
    lang: opts.lang,
    searchText: buildSearchText(core),
  }
}
