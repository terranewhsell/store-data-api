/**
 * Field coverage matrix, per source.
 *
 * This file is the honest answer to "why is this null?", written down once
 * instead of discovered by whoever integrates. It is also what `/v1/apps` reports
 * in `_meta.fieldCoverage`, so the answer travels with the data.
 *
 * The two reasons mean different things and the distinction is kept strict:
 *
 *   not_applicable  the store's product model has no equivalent. An Android
 *                   minimum version for a Steam game is not missing data, it is
 *                   a category error.
 *
 *   not_available   the concept exists in that store, but the official API we
 *                   use does not return it. These are the fields that could be
 *                   filled later, at a cost the client should get to weigh: for
 *                   App Store it would mean scraping Apple, which is exactly what
 *                   using the official API was meant to avoid.
 */
import type { CanonicalField, CoverageReason, FieldCoverage, Source } from './contract.ts'

type Matrix = Partial<Record<CanonicalField, CoverageReason>>

/**
 * Google Play, via google-play-scraper.
 *
 * Two fields in the client's example are not produced by the current version of
 * that library. They were in its output years ago, which is where the example
 * came from, and Google has since stopped exposing them in the page payload:
 *
 *   editorsChoice  the badge exists in the store; the library no longer extracts it
 *   features       the "Uses Google Play Games / Achievements" block, same story
 *
 * They stay in the contract, always present, always null, and always accounted
 * for here. Filling them would mean parsing Play's HTML ourselves, which is more
 * fragile than the library we deliberately chose not to replace.
 */
const PLAY: Matrix = {
  /**
   * Always empty, by design rather than by accident.
   *
   * Individual reviews are a separate, paginated request per app on every store.
   * Fetching them would multiply the ingest cost several times over for content
   * that ages faster than anything else in the record. The field stays in the
   * contract because the client's example had it, and it is declared here so the
   * coverage report says "we do not fetch these" instead of showing a field that
   * claims to be fillable and never is.
   */
  comments: 'not_available',
  editorsChoice: 'not_available',
  features: 'not_available',
  iosId: 'not_available',
}

/**
 * App Store, via the official iTunes Search/Lookup API.
 *
 * Everything marked `not_available` here exists on the App Store product page but
 * not in the public API. Getting them means scraping Apple, and the whole point
 * of preferring the official API was to keep the scraping risk confined to a
 * single source.
 */
const IOS: Matrix = {
  // Apple does not publish install counts, at all, anywhere.
  installs: 'not_applicable',
  minInstalls: 'not_applicable',
  maxInstalls: 'not_applicable',
  androidVersion: 'not_applicable',
  androidVersionText: 'not_applicable',
  androidMaxVersion: 'not_applicable',
  isAvailableInPlayPass: 'not_applicable',
  preregister: 'not_applicable',
  earlyAccessEnabled: 'not_applicable',
  adSupported: 'not_applicable',
  features: 'not_applicable',

  comments: 'not_available', // see the note on PLAY.comments

  // On the page, not in the API.
  summary: 'not_available', // the App Store "subtitle"
  histogram: 'not_available', // only the average and the count are exposed
  offersIAP: 'not_available',
  IAPRange: 'not_available',
  developerEmail: 'not_available',
  developerAddress: 'not_available',
  developerLegalName: 'not_available',
  developerLegalEmail: 'not_available',
  developerLegalAddress: 'not_available',
  developerLegalPhoneNumber: 'not_available',
  privacyPolicy: 'not_available',
  editorsChoice: 'not_available',
  video: 'not_available',
  videoImage: 'not_available',
  previewVideo: 'not_available',
  headerImage: 'not_available',
}

/**
 * Steam, via the public store endpoints.
 *
 * `histogram` is the notable one. Steam reports a positive/negative split, not a
 * per-star breakdown. There is no honest way to turn two numbers into five, so it
 * stays null. The real numbers are in `extra.steam`, and `score` is derived from
 * them with the formula recorded in `_meta.derivedFields`.
 */
const STEAM: Matrix = {
  installs: 'not_applicable',
  minInstalls: 'not_applicable',
  maxInstalls: 'not_applicable',
  androidVersion: 'not_applicable',
  androidVersionText: 'not_applicable',
  androidMaxVersion: 'not_applicable',
  isAvailableInPlayPass: 'not_applicable',
  preregister: 'not_applicable',
  editorsChoice: 'not_applicable',
  adSupported: 'not_applicable',
  features: 'not_applicable',
  version: 'not_applicable',
  developerId: 'not_applicable',
  developerInternalID: 'not_applicable',
  iosId: 'not_applicable',
  appId: 'not_applicable', // Steam has no Android package name; `appId` carries the Steam appid

  comments: 'not_available', // see the note on PLAY.comments

  // Real per-star data does not exist. Not simulated. See extra.steam.
  histogram: 'not_available',
  developerEmail: 'not_available',
  developerAddress: 'not_available',
  developerLegalName: 'not_available',
  developerLegalEmail: 'not_available',
  developerLegalAddress: 'not_available',
  developerLegalPhoneNumber: 'not_available',
  privacyPolicy: 'not_available',
  recentChanges: 'not_available', // patch notes live in the news API, not appdetails
  updated: 'not_available',
  contentRatingDescription: 'not_available',
  summary: 'not_available',
}

const MATRIX: Record<Source, Matrix> = { play: PLAY, ios: IOS, steam: STEAM }

/** The static, source-level matrix. Fields structurally absent for a source. */
export function baseCoverage(source: Source): FieldCoverage {
  return { ...MATRIX[source] }
}

/**
 * Completes the static matrix with what actually happened for this record: any
 * canonical field that came back null and is not already explained gets
 * `not_available`. A consumer therefore never sees an unexplained null.
 */
export function completeCoverage(
  source: Source,
  core: Record<string, unknown>,
  fields: readonly CanonicalField[],
): FieldCoverage {
  const coverage = baseCoverage(source)
  for (const field of fields) {
    if (coverage[field]) continue
    const value = core[field]
    const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0)
    if (empty) coverage[field] = 'not_available'
  }
  return coverage
}

/** Documentation helper: which fields a source can never fill, and why. */
export function coverageReport(): Record<Source, Matrix> {
  return { play: { ...PLAY }, ios: { ...IOS }, steam: { ...STEAM } }
}
