/**
 * App Store -> canonical.
 *
 * Everything here comes from Apple's official Search/Lookup API. Fields the API
 * does not expose stay null and are explained by the coverage matrix; none of
 * them is guessed from a neighbouring value.
 *
 * `appId` deserves a note. For a Play record `appId` is the Android package name.
 * For an App Store record there is no package name, so `appId` carries the native
 * App Store identifier in the `id123456789` form the client used, and `iosId`
 * carries the same value. That way `appId` always means "this record's id in its
 * own store" and `iosId` always means "the App Store listing", and neither ever
 * contradicts the other.
 */
import type { ItunesApp } from '../sources/ios.ts'
import { isGame } from '../sources/ios.ts'
import {
  CANONICAL_FIELDS,
  emptyCanonical,
  type CanonicalApp,
  type CategoryRef,
  type NormalizedApp,
} from './contract.ts'
import { buildCommon, iosMinimumOs } from './common.ts'
import { completeCoverage } from './coverage.ts'
import { buildSearchText, num, scoreToText, str, strArray, toEpochMs } from './shared.ts'

/**
 * Apple returns the description as plain text with newlines, not HTML. The
 * contract has both fields, so the HTML variant is built from the plain text by
 * turning newlines into line breaks and escaping the rest. That is a formatting
 * change, not invented content: no words are added or removed.
 */
function descriptionToHtml(text: string | null): string | null {
  if (text === null) return null
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return escaped.replace(/\r\n|\r|\n/g, '<br>')
}

function toCategories(app: ItunesApp): CategoryRef[] {
  const names = Array.isArray(app.genres) ? (app.genres as unknown[]) : []
  const ids = Array.isArray(app.genreIds) ? (app.genreIds as unknown[]) : []
  const out: CategoryRef[] = []
  for (let i = 0; i < names.length; i++) {
    const name = str(names[i])
    const id = str(ids[i])
    if (name === null && id === null) continue
    out.push({ name, id })
  }
  return out
}

/** Apple's `advisories` is an array of strings; the contract wants one field. */
function advisories(app: ItunesApp): string | null {
  const list = strArray(app.advisories)
  return list.length > 0 ? list.join(', ') : null
}

/** Best available artwork, largest first. */
function icon(app: ItunesApp): string | null {
  return str(app.artworkUrl512) ?? str(app.artworkUrl100) ?? str(app.artworkUrl60)
}

export interface IosNormalizeOptions {
  country: string
  lang: string
}

export function normalizeIosApp(app: ItunesApp, opts: IosNormalizeOptions): NormalizedApp {
  const core: CanonicalApp = emptyCanonical()

  const trackId = String(app.trackId)
  const iosId = `id${trackId}`

  core.title = str(app.trackName)
  core.description = str(app.description)
  core.descriptionHTML = descriptionToHtml(core.description)
  core.score = num(app.averageUserRating)
  core.scoreText = scoreToText(core.score)
  core.ratings = num(app.userRatingCount) === null ? null : Math.trunc(num(app.userRatingCount) as number)
  // Apple exposes a rating count, not a written-review count. They are different
  // numbers and conflating them would overstate `reviews`, so it stays null.
  core.reviews = null

  core.price = num(app.price)
  core.free = core.price === null ? null : core.price === 0
  core.currency = str(app.currency)
  core.priceText = str(app.formattedPrice)

  core.developer = str(app.artistName) ?? str(app.sellerName)
  core.developerId = str(app.artistId)
  core.developerInternalID = str(app.artistId)
  core.developerWebsite = str(app.sellerUrl) ?? str(app.artistViewUrl)

  core.genre = str(app.primaryGenreName)
  core.genreId = str(app.primaryGenreId)
  core.categories = toCategories(app)

  core.icon = icon(app)
  core.screenshots = [...strArray(app.screenshotUrls), ...strArray(app.ipadScreenshotUrls)]

  core.contentRating = str(app.trackContentRating) ?? str(app.contentAdvisoryRating)
  core.contentRatingDescription = advisories(app)

  core.released = str(app.releaseDate)
  core.updated = toEpochMs(app.currentVersionReleaseDate)
  core.version = str(app.version)
  core.recentChanges = str(app.releaseNotes)

  core.appId = iosId
  core.iosId = iosId
  core.url = str(app.trackViewUrl)
  core.type = isGame(app) ? 'game' : 'app'

  const extra: Record<string, unknown> = {
    bundleId: str(app.bundleId),
    sellerName: str(app.sellerName),
    trackId,
    minimumOsVersion: str(app.minimumOsVersion),
    fileSizeBytes: str(app.fileSizeBytes),
    supportedDevices: strArray(app.supportedDevices),
    languageCodesISO2A: strArray(app.languageCodesISO2A),
    contentAdvisoryRating: str(app.contentAdvisoryRating),
    advisories: strArray(app.advisories),
    // Apple's own `features` array (values like "iosUniversal"). Deliberately
    // NOT mapped onto the contract's `features`, which is a Play Games concept
    // with a title and a description. Same word, different thing.
    appleFeatures: strArray(app.features),
    isGameCenterEnabled: app.isGameCenterEnabled ?? null,
    genreIds: strArray(app.genreIds),
    appletvScreenshotUrls: strArray(app.appletvScreenshotUrls),
    averageUserRatingForCurrentVersion: num(app.averageUserRatingForCurrentVersion),
    userRatingCountForCurrentVersion: num(app.userRatingCountForCurrentVersion),
  }

  const sellerName = str(app.sellerName)
  const artistName = str(app.artistName)

  return {
    core,
    /**
     * Apple fills three of the five common fields, including two that Google
     * Play never publishes: the download size and the language list.
     *
     * `reviewSummary` stays null. Apple gives an average and a count but no
     * positive/negative split, and there is no way to recover one from a mean.
     */
    common: buildCommon({
      minimumOs: iosMinimumOs(str(app.minimumOsVersion)),
      downloadSizeBytes: num(app.fileSizeBytes),
      supportedLanguages: strArray(app.languageCodesISO2A),
      // Only when it actually differs; on most listings Apple repeats the
      // developer name and a duplicate would imply a distinction that is not there.
      publisher: sellerName && sellerName !== artistName ? sellerName : null,
    }),
    extra: { ios: extra },
    coverage: completeCoverage('ios', core as unknown as Record<string, unknown>, CANONICAL_FIELDS),
    derived: {},
    source: 'ios',
    sourceId: iosId,
    country: opts.country,
    lang: opts.lang,
    searchText: buildSearchText(core),
  }
}
