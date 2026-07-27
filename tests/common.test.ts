/**
 * Cross-store equivalents and the review summary.
 *
 * The governing rule under test: a canonical field keeps its platform-specific
 * meaning and stays null where it does not apply, while `common` answers the same
 * underlying question in a shape that works everywhere. Neither is allowed to
 * invent a value.
 */
import { describe, expect, test } from 'bun:test'
import {
  attachRankings,
  reviewSummaryFromHistogram,
  reviewSummaryFromSteamSpy,
  reviewSummaryFromValve,
  steamLanguages,
  steamMinimumOs,
} from '../src/normalize/common.ts'
import { emptyCommon, type RankingPosition } from '../src/normalize/contract.ts'
import { normalizeIosApp } from '../src/normalize/ios.ts'
import { normalizePlayApp } from '../src/normalize/play.ts'
import { normalizeSteamApp } from '../src/normalize/steam.ts'
import { ITUNES_TRANSLATE, PLAY_TRANSLATE, STEAM_REVIEWS, STEAM_TF2 } from './fixtures.ts'

const MARKET = { country: 'us', lang: 'en' }

describe('minimum OS, the cross-store equivalent', () => {
  test('Play reports VARY as text with no comparable version', () => {
    const { common } = normalizePlayApp(PLAY_TRANSLATE, MARKET)
    expect(common.minimumOs?.platform).toBe('android')
    // "Varies with device" is a real answer, not a missing one.
    expect(common.minimumOs?.version).toBeNull()
    expect(common.minimumOs?.text).toBe('Varies with device')
    expect(common.minimumOs?.sourceField).toBe('androidVersion')
  })

  test('iOS reports the exact version Apple publishes', () => {
    const { common, core } = normalizeIosApp(ITUNES_TRANSLATE as never, MARKET)
    expect(common.minimumOs?.platform).toBe('ios')
    expect(common.minimumOs?.version).toBe('15.0')
    expect(common.minimumOs?.sourceField).toBe('minimumOsVersion')
    // The canonical Android field stays null. Writing "15.0" into a field named
    // androidVersion would assert something false.
    expect(core.androidVersion).toBeNull()
  })

  test('Steam takes the platform from a structured field', () => {
    const { common } = normalizeSteamApp(STEAM_TF2 as never, { ...MARKET, reviews: STEAM_REVIEWS })
    expect(common.minimumOs?.platform).toBe('windows')
  })

  test('Steam parses a version only when the prose is unambiguous', () => {
    const withVersion = steamMinimumOs({
      platforms: { windows: true },
      pc_requirements: { minimum: '<strong>OS:</strong> Windows 10 64-bit<br>' },
    })
    expect(withVersion?.version).toBe('10')
    expect(withVersion?.text).toContain('Windows 10')

    // Valve's real text for Counter-Strike 2. The trademark symbol sat between
    // the name and the number and blocked every match until the pattern stopped
    // insisting on whitespace there.
    const trademarked = steamMinimumOs({
      platforms: { windows: true },
      pc_requirements: { minimum: '<strong>OS:</strong> Windows® 10<br>' },
    })
    expect(trademarked?.version).toBe('10')

    // Publisher-written prose with no recognisable version leaves it null rather
    // than guessing a number out of marketing copy.
    const vague = steamMinimumOs({
      platforms: { windows: true },
      pc_requirements: { minimum: '<strong>OS:</strong> A reasonably modern PC<br>' },
    })
    expect(vague?.platform).toBe('windows')
    expect(vague?.version).toBeNull()
  })

  test('no platform information at all yields null, not a default', () => {
    expect(steamMinimumOs({})).toBeNull()
  })
})

describe('the other cross-store equivalents', () => {
  test('Apple fills the download size that Google Play never publishes', () => {
    const ios = normalizeIosApp(ITUNES_TRANSLATE as never, MARKET)
    const play = normalizePlayApp(PLAY_TRANSLATE, MARKET)
    expect(ios.common.downloadSizeBytes).toBe(123456789)
    expect(play.common.downloadSizeBytes).toBeNull()
  })

  test('Apple fills the language list', () => {
    const { common } = normalizeIosApp(ITUNES_TRANSLATE as never, MARKET)
    expect(common.supportedLanguages).toEqual(['EN', 'ES'])
  })

  test('Steam separates publisher from developer; the mobile stores do not', () => {
    const steam = normalizeSteamApp(STEAM_TF2 as never, { ...MARKET, reviews: STEAM_REVIEWS })
    expect(steam.common.publisher).toBe('Valve')
    expect(normalizePlayApp(PLAY_TRANSLATE, MARKET).common.publisher).toBeNull()
  })

  test('a publisher identical to the developer is not repeated', () => {
    // Apple echoes the developer name into sellerName on most listings; copying
    // it would imply a distinction that is not there.
    const { common } = normalizeIosApp(
      { ...ITUNES_TRANSLATE, sellerName: 'Google', artistName: 'Google' } as never,
      MARKET,
    )
    expect(common.publisher).toBeNull()
  })

  test('Steam language markup is stripped to plain names', () => {
    expect(
      steamLanguages('English<strong>*</strong>, French, German<br>* languages with full audio'),
    ).toEqual(['English', 'French', 'German'])
    expect(steamLanguages('')).toEqual([])
    expect(steamLanguages(null)).toEqual([])
  })
})

describe('review summary', () => {
  test('Play derives it from the histogram and says so', () => {
    const { common } = normalizePlayApp(PLAY_TRANSLATE, MARKET)
    const summary = common.reviewSummary!

    // 4 and 5 stars positive, 1 and 2 negative, 3 excluded.
    expect(summary.positive).toBe(856865 + 5063481)
    expect(summary.negative).toBe(370042 + 145558)
    expect(summary.total).toBe(summary.positive! + summary.negative!)
    expect(summary.percentPositive).toBeGreaterThan(90)
    expect(summary.provenance.provider).toBe('play')
    expect(summary.provenance.authoritative).toBe(true)
    expect(summary.provenance.derivedFrom).toContain('three-star')
  })

  test('Play reports the neutral bucket instead of hiding it', () => {
    const { common, core } = normalizePlayApp(PLAY_TRANSLATE, MARKET)
    const s = common.reviewSummary!

    // Exposed, not folded into a side: a consumer who prefers another convention
    // can recompute the ratio without us redeploying.
    expect(s.neutral).toBe(375720)
    expect(s.total).toBe(s.positive! + s.negative!)

    // Google's own five buckets do not sum to its ratings count, so no
    // convention would make these equal. Better shown than hidden.
    const bucketSum = s.positive! + s.negative! + s.neutral!
    expect(bucketSum).not.toBe(core.ratings)
  })

  test('a binary scale reports no neutral bucket', () => {
    // Steam's thumb has no middle, so null rather than zero: zero would claim
    // nobody was ambivalent, which is not something Valve measures.
    const valve = reviewSummaryFromValve({
      positive: 900, negative: 100, total: 1000, label: 'Very Positive',
    })
    expect(valve?.neutral).toBeNull()
    expect(reviewSummaryFromSteamSpy({ positive: 8, negative: 2 })?.neutral).toBeNull()
  })

  test('Valve numbers are marked authoritative', () => {
    const summary = reviewSummaryFromValve({
      positive: 900,
      negative: 100,
      total: 1000,
      label: 'Overwhelmingly Positive',
    })
    expect(summary?.percentPositive).toBe(90)
    expect(summary?.label).toBe('Overwhelmingly Positive')
    expect(summary?.provenance.provider).toBe('steam')
    expect(summary?.provenance.authoritative).toBe(true)
  })

  test('SteamSpy numbers are marked NOT authoritative', () => {
    // The whole point: a third-party approximation must never be
    // indistinguishable from the store's own figure.
    const summary = reviewSummaryFromSteamSpy({ positive: 7642084, negative: 1173003 })
    expect(summary?.provenance.provider).toBe('steamspy')
    expect(summary?.provenance.authoritative).toBe(false)
    expect(summary?.provenance.derivedFrom).toContain('approximate')
    // SteamSpy publishes no wording, so none is invented.
    expect(summary?.label).toBeNull()
  })

  test('Valve wins over SteamSpy when both are present', () => {
    const { common } = normalizeSteamApp(STEAM_TF2 as never, {
      ...MARKET,
      reviews: STEAM_REVIEWS,
      steamSpy: { positive: 1, negative: 1 },
    })
    expect(common.reviewSummary?.provenance.provider).toBe('steam')
    expect(common.reviewSummary?.positive).toBe(900)
  })

  test('SteamSpy is used only when Valve is absent', () => {
    const { common } = normalizeSteamApp(STEAM_TF2 as never, {
      ...MARKET,
      reviews: null,
      steamSpy: { positive: 800, negative: 200 },
    })
    expect(common.reviewSummary?.provenance.provider).toBe('steamspy')
    expect(common.reviewSummary?.percentPositive).toBe(80)
  })

  test('Apple gets no summary: an average cannot be split back', () => {
    const { common, core } = normalizeIosApp(ITUNES_TRANSLATE as never, MARKET)
    expect(common.reviewSummary).toBeNull()
    // The average and the count are still there; only the split is impossible.
    expect(core.score).toBeGreaterThan(4)
    expect(core.ratings).toBe(1234567)
  })

  test('an empty histogram produces no summary rather than zeroes', () => {
    expect(reviewSummaryFromHistogram(null)).toBeNull()
    expect(
      reviewSummaryFromHistogram({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }),
    ).toBeNull()
  })

  test('the histogram is never reconstructed from a split', () => {
    const { core } = normalizeSteamApp(STEAM_TF2 as never, { ...MARKET, reviews: STEAM_REVIEWS })
    expect(core.histogram).toBeNull()
  })
})

describe('ranking placements', () => {
  const rank = (position: number, collection: string): RankingPosition => ({
    source: 'play',
    collection,
    categoryId: 'APPLICATION',
    country: 'us',
    lang: 'en',
    position,
    capturedAt: '2026-07-27T00:00:00.000Z',
  })

  test('placements are sorted and the best one is surfaced', () => {
    const common = attachRankings(emptyCommon(), [rank(12, 'GROSSING'), rank(3, 'TOP_FREE')])
    expect(common.rankings.map((r) => r.position)).toEqual([3, 12])
    expect(common.bestRank?.collection).toBe('TOP_FREE')
  })

  test('an app in no chart gets an empty list and a null best, not missing keys', () => {
    // Most apps are in no chart. That is a real answer, not absent data.
    const common = attachRankings(emptyCommon(), [])
    expect(common.rankings).toEqual([])
    expect(common.bestRank).toBeNull()
  })
})

describe('common block shape', () => {
  test('every source emits the same keys', () => {
    const expected = Object.keys(emptyCommon()).sort()
    for (const normalized of [
      normalizePlayApp(PLAY_TRANSLATE, MARKET),
      normalizeIosApp(ITUNES_TRANSLATE as never, MARKET),
      normalizeSteamApp(STEAM_TF2 as never, { ...MARKET, reviews: STEAM_REVIEWS }),
    ]) {
      expect(Object.keys(normalized.common).sort()).toEqual(expected)
    }
  })

  test('it survives a JSON round trip with no undefined', () => {
    const { common } = normalizeIosApp(ITUNES_TRANSLATE as never, MARKET)
    expect(JSON.parse(JSON.stringify(common))).toEqual(common)
  })
})
