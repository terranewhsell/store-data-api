/**
 * The categories the client supplied must come back exactly as supplied.
 *
 * This is the one part of the contract with a single unambiguous right answer, so
 * it is checked entry by entry rather than by count.
 */
import { describe, expect, test } from 'bun:test'
import gplay from 'google-play-scraper'
import {
  CATEGORIES,
  CATEGORIES_WITHOUT_PLAY_MAPPING,
  PLAY_INGESTABLE_CATEGORY_IDS,
  categoryById,
  categoryBySlug,
  isIngestableOnPlay,
  resolveCategory,
} from '../src/data/categories.ts'

/**
 * The client's list, transcribed from their message. Kept separate from the
 * shipped file on purpose: if someone edits src/data/categories.json, this fails.
 */
const CLIENT_IDS = [
  'APPLICATION', 'ANDROID_WEAR', 'ART_AND_DESIGN', 'AUTO_AND_VEHICLES', 'BEAUTY',
  'BOOKS_AND_REFERENCE', 'BUSINESS', 'COMICS', 'COMMUNICATION', 'DATING',
  'EDUCATION', 'ENTERTAINMENT', 'EVENTS', 'FINANCE', 'FOOD_AND_DRINK',
  'HEALTH_AND_FITNESS', 'HOUSE_AND_HOME', 'LIBRARIES_AND_DEMO', 'LIFESTYLE',
  'MAPS_AND_NAVIGATION', 'MEDICAL', 'MUSIC_AND_AUDIO', 'NEWS_AND_MAGAZINES',
  'PARENTING', 'PERSONALIZATION', 'PHOTOGRAPHY', 'PRODUCTIVITY', 'SHOPPING',
  'SOCIAL', 'SPORTS', 'TOOLS', 'TRAVEL_AND_LOCAL', 'VIDEO_PLAYERS', 'WATCH_FACE',
  'WEATHER', 'GAME', 'GAME_ACTION', 'GAME_ADVENTURE', 'GAME_ARCADE', 'GAME_BOARD',
  'GAME_CARD', 'GAME_CASINO', 'GAME_CASUAL', 'GAME_EDUCATIONAL', 'GAME_MUSIC',
  'GAME_PUZZLE', 'GAME_RACING', 'GAME_ROLE_PLAYING', 'GAME_SIMULATION',
  'GAME_SPORTS', 'GAME_STRATEGY', 'GAME_TRIVIA', 'GAME_WORD', 'FAMILY',
  'GAME_WORLD',
]

describe('canonical categories', () => {
  test('there are 55 of them, not 57', () => {
    // The setup document claimed 57. Counted one by one against the client's
    // message, it is 55. The wrong number would have made the delivery check fail.
    expect(CATEGORIES).toHaveLength(55)
    expect(CLIENT_IDS).toHaveLength(55)
  })

  test('same ids in the same order the client sent', () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual(CLIENT_IDS)
  })

  test('every slug is the kebab-case of its id, and unique', () => {
    for (const category of CATEGORIES) {
      expect(category.slug).toBe(category.id.toLowerCase().replace(/_/g, '-'))
    }
    expect(new Set(CATEGORIES.map((c) => c.slug)).size).toBe(55)
  })

  test('every name is the title-case of its id', () => {
    for (const category of CATEGORIES) {
      const expected = category.id
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
      expect(category.name).toBe(expected)
    }
  })

  test('the list is frozen, so nothing can mutate it at runtime', () => {
    expect(Object.isFrozen(CATEGORIES)).toBe(true)
    expect(Object.isFrozen(CATEGORIES[0])).toBe(true)
  })
})

describe('relationship with the Google Play taxonomy', () => {
  test('the first 54 are exactly google-play-scraper constants, in order', () => {
    const libraryIds = Object.values(gplay.category) as string[]
    expect(libraryIds).toHaveLength(54)
    expect(CATEGORIES.slice(0, 54).map((c) => c.id)).toEqual(libraryIds)
  })

  test('GAME_WORLD is not a Play category and is flagged as such', () => {
    const libraryIds = Object.values(gplay.category) as string[]
    expect(libraryIds).not.toContain('GAME_WORLD')

    // Served, because the client asked for the list verbatim.
    expect(categoryById('GAME_WORLD')).toBeDefined()
    // Never sent to Play, which would throw `Invalid category`.
    expect(isIngestableOnPlay('GAME_WORLD')).toBe(false)
    expect(CATEGORIES_WITHOUT_PLAY_MAPPING).toContain('GAME_WORLD')
    expect(PLAY_INGESTABLE_CATEGORY_IDS).not.toContain('GAME_WORLD')
    expect(PLAY_INGESTABLE_CATEGORY_IDS).toHaveLength(54)
  })
})

describe('lookup helpers', () => {
  test('by id and by slug', () => {
    expect(categoryById('GAME_ACTION')?.name).toBe('Game Action')
    expect(categoryBySlug('game-action')?.id).toBe('GAME_ACTION')
    expect(categoryById('NOPE')).toBeUndefined()
  })

  test('resolveCategory accepts either form', () => {
    expect(resolveCategory('TOOLS')?.id).toBe('TOOLS')
    expect(resolveCategory('tools')?.id).toBe('TOOLS')
    expect(resolveCategory('Tools')?.id).toBe('TOOLS')
    expect(resolveCategory('not-a-category')).toBeUndefined()
  })
})
