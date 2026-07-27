/**
 * The contract check the brief asks for: compare what we return against the
 * client's object FIELD BY FIELD. Same names, same types, nothing missing and
 * nothing extra.
 *
 * The list below is transcribed from their Discord message, not imported from our
 * own contract file. Importing it would make this test tautological.
 */
import { describe, expect, test } from 'bun:test'
import { CANONICAL_FIELDS, emptyCanonical } from '../src/normalize/contract.ts'
import { normalizePlayApp } from '../src/normalize/play.ts'
import { normalizeIosApp } from '../src/normalize/ios.ts'
import { normalizeSteamApp } from '../src/normalize/steam.ts'
import {
  ITUNES_TRANSLATE,
  PLAY_TRANSLATE,
  STEAM_REVIEWS,
  STEAM_TF2,
} from './fixtures.ts'

/**
 * Exactly the keys the client listed, in their order.
 * `isAvailableInPlayPass` appeared twice in their message; it is one field.
 */
const CLIENT_FIELDS: string[] = [
  'title', 'description', 'descriptionHTML', 'summary', 'installs', 'minInstalls',
  'maxInstalls', 'score', 'scoreText', 'ratings', 'reviews', 'histogram', 'price',
  'free', 'currency', 'priceText', 'offersIAP', 'IAPRange', 'androidVersion',
  'androidVersionText', 'androidMaxVersion', 'developer', 'developerId',
  'developerEmail', 'developerWebsite', 'developerAddress', 'developerLegalName',
  'developerLegalEmail', 'developerLegalAddress', 'developerLegalPhoneNumber',
  'privacyPolicy', 'developerInternalID', 'genre', 'genreId', 'categories', 'icon',
  'headerImage', 'screenshots', 'video', 'videoImage', 'previewVideo',
  'contentRating', 'contentRatingDescription', 'adSupported', 'released', 'updated',
  'version', 'recentChanges', 'comments', 'preregister', 'earlyAccessEnabled',
  'isAvailableInPlayPass', 'editorsChoice', 'features', 'appId', 'iosId', 'url',
  'type',
]

describe('canonical field list', () => {
  test('matches the client message exactly, in order', () => {
    expect([...CANONICAL_FIELDS] as string[]).toEqual(CLIENT_FIELDS)
    expect(CANONICAL_FIELDS).toHaveLength(58)
  })

  test('an empty record still carries every key', () => {
    const empty = emptyCanonical() as unknown as Record<string, unknown>
    for (const field of CLIENT_FIELDS) {
      expect(Object.hasOwn(empty, field)).toBe(true)
    }
    expect(Object.keys(empty).sort()).toEqual([...CLIENT_FIELDS].sort())
  })
})

const NORMALIZED = {
  play: normalizePlayApp(PLAY_TRANSLATE, { country: 'us', lang: 'en' }),
  ios: normalizeIosApp(ITUNES_TRANSLATE as never, { country: 'us', lang: 'en' }),
  steam: normalizeSteamApp(STEAM_TF2 as never, {
    country: 'us',
    lang: 'en',
    reviews: STEAM_REVIEWS,
  }),
}

describe.each(Object.entries(NORMALIZED))('%s normalizer', (source, normalized) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions below check the types
  const core = normalized.core as unknown as Record<string, any>

  test('emits every canonical key and nothing else', () => {
    expect(Object.keys(core).sort()).toEqual([...CLIENT_FIELDS].sort())
  })

  test('no key holds undefined: JSON has no such value', () => {
    // The client's example is JavaScript and uses `undefined` for absent fields.
    // Serialised to JSON those keys would simply vanish, which would break the
    // "every key always present" guarantee. They are null instead.
    for (const [key, value] of Object.entries(core)) {
      expect(value === undefined, `${source}.${key} is undefined`).toBe(false)
    }
    expect(JSON.parse(JSON.stringify(core))).toEqual(core)
  })

  test('collection fields are arrays, never null', () => {
    expect(Array.isArray(core.categories)).toBe(true)
    expect(Array.isArray(core.screenshots)).toBe(true)
    expect(Array.isArray(core.comments)).toBe(true)
    expect(Array.isArray(core.features)).toBe(true)
  })

  test('type is app or game', () => {
    expect(['app', 'game']).toContain(core.type)
  })

  test('every null is explained in the coverage map', () => {
    for (const field of CLIENT_FIELDS) {
      const value = core[field]
      const isEmpty = value === null || (Array.isArray(value) && value.length === 0)
      if (!isEmpty) continue
      expect(
        normalized.coverage[field as keyof typeof normalized.coverage],
        `${source}.${field} is null with no coverage reason`,
      ).toBeDefined()
    }
  })

  test('scalar types match the client example', () => {
    const expectType = (field: string, types: string[]) => {
      const value = core[field]
      if (value === null) return
      expect(types, `${source}.${field} was ${typeof value}`).toContain(typeof value)
    }
    for (const field of ['title', 'description', 'descriptionHTML', 'summary', 'installs',
      'scoreText', 'currency', 'priceText', 'IAPRange', 'androidVersion',
      'androidVersionText', 'androidMaxVersion', 'developer', 'developerId',
      'developerEmail', 'developerWebsite', 'developerAddress', 'privacyPolicy',
      'developerInternalID', 'genre', 'genreId', 'icon', 'headerImage', 'video',
      'videoImage', 'previewVideo', 'contentRating', 'contentRatingDescription',
      'released', 'version', 'recentChanges', 'appId', 'iosId', 'url']) {
      expectType(field, ['string'])
    }
    for (const field of ['minInstalls', 'maxInstalls', 'score', 'ratings', 'reviews',
      'price', 'updated']) {
      expectType(field, ['number'])
    }
    for (const field of ['free', 'offersIAP', 'adSupported', 'preregister',
      'earlyAccessEnabled', 'isAvailableInPlayPass', 'editorsChoice']) {
      expectType(field, ['boolean'])
    }
  })
})

describe('play normalization specifics', () => {
  const { coverage } = NORMALIZED.play
  const core = NORMALIZED.play.core as unknown as Record<string, any>

  test('carries the values straight through', () => {
    expect(core.title).toBe('Google Translate')
    expect(core.appId).toBe('com.google.android.apps.translate')
    expect(core.minInstalls).toBe(1000000000)
    expect(core.histogram).toEqual({
      '1': 370042, '2': 145558, '3': 375720, '4': 856865, '5': 5063481,
    })
    expect(core.type).toBe('app')
  })

  test('undefined in the source becomes null, not a missing key', () => {
    expect(core.IAPRange).toBeNull()
    expect(core.video).toBeNull()
    expect(core.released).toBeNull()
    expect(core.developerLegalName).toBeNull()
  })

  test('HTML entities are decoded in text fields', () => {
    // The exact bug the client reported on the coupons project.
    expect(core.recentChanges).toBe('Improved offline translations — faster downloads')
    expect(core.recentChanges).not.toContain('&#8212;')
  })

  test('a category with a null id survives as the client showed it', () => {
    expect(core.categories).toEqual([
      { name: 'Tools', id: 'TOOLS' },
      { name: 'Another category without id', id: null },
    ])
  })

  test('editorsChoice and features are null because the library dropped them', () => {
    // Present in the client's example, no longer produced by google-play-scraper.
    expect(core.editorsChoice).toBeNull()
    expect(core.features).toEqual([])
    expect(coverage.editorsChoice).toBe('not_available')
    expect(coverage.features).toBe('not_available')
  })

  test('fields the library returns but the contract lacks go to extra', () => {
    expect(NORMALIZED.play.extra.play).toBeDefined()
    expect(NORMALIZED.play.extra.play?.available).toBe(true)
  })
})

describe('ios normalization specifics', () => {
  const { coverage } = NORMALIZED.ios
  const core = NORMALIZED.ios.core as unknown as Record<string, any>

  test('appId carries the App Store id and never contradicts iosId', () => {
    expect(core.appId).toBe('id414706506')
    expect(core.iosId).toBe('id414706506')
  })

  test('install counts are not_applicable, because Apple never publishes them', () => {
    expect(core.installs).toBeNull()
    expect(coverage.installs).toBe('not_applicable')
    expect(coverage.minInstalls).toBe('not_applicable')
    expect(coverage.androidVersion).toBe('not_applicable')
  })

  test('the histogram is not_available, and not fabricated from the average', () => {
    expect(core.histogram).toBeNull()
    expect(coverage.histogram).toBe('not_available')
  })

  test('rating count and review count are not conflated', () => {
    expect(core.ratings).toBe(1234567)
    // Apple exposes a rating count only. Reusing it as `reviews` would overstate.
    expect(core.reviews).toBeNull()
  })

  test('descriptionHTML is a formatting of the text, with nothing added', () => {
    expect(core.descriptionHTML).toBe(
      'Translate between up to 108 languages.<br>Text translation.',
    )
  })

  test('Apple own features array is kept apart from the contract features field', () => {
    expect(core.features).toEqual([])
    expect(NORMALIZED.ios.extra.ios?.appleFeatures).toEqual(['iosUniversal'])
  })
})

describe('steam normalization specifics', () => {
  const { coverage, derived } = NORMALIZED.steam
  const core = NORMALIZED.steam.core as unknown as Record<string, any>

  test('the histogram stays null: two numbers cannot become five', () => {
    expect(core.histogram).toBeNull()
    expect(coverage.histogram).toBe('not_available')
  })

  test('the score is derived and says so', () => {
    // 900 positive of 1000 -> 4.5 out of 5.
    expect(core.score).toBe(4.5)
    expect(core.scoreText).toBe('4.5')
    expect(derived.score).toContain('total_positive / total_reviews')
  })

  test('the real Steam numbers are preserved untouched', () => {
    expect(NORMALIZED.steam.extra.steam?.reviewSummary).toEqual({
      reviewScore: 9,
      reviewScoreDesc: 'Overwhelmingly Positive',
      totalPositive: 900,
      totalNegative: 100,
      totalReviews: 1000,
    })
  })

  test('offersIAP is derived from the store category and marked', () => {
    expect(core.offersIAP).toBe(true)
    expect(derived.offersIAP).toContain('category 35')
  })

  test('android fields are not_applicable rather than missing data', () => {
    expect(coverage.androidVersion).toBe('not_applicable')
    expect(coverage.installs).toBe('not_applicable')
    expect(coverage.isAvailableInPlayPass).toBe('not_applicable')
  })

  test('Steam-only data lands in extra', () => {
    expect(NORMALIZED.steam.extra.steam?.metacritic).toEqual({
      score: 92,
      url: 'https://www.metacritic.com/game/pc/team-fortress-2',
    })
    expect(NORMALIZED.steam.extra.steam?.platforms).toEqual({
      windows: true,
      mac: true,
      linux: true,
    })
  })

  test('a free game reports price 0, not null', () => {
    expect(core.free).toBe(true)
    expect(core.price).toBe(0)
  })
})
