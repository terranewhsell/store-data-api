/**
 * Cross-store matching.
 *
 * The rule under test is that a wrong `iosId` is worse than a null one: it sends
 * a user to a different product and, unlike a null, it looks right.
 */
import { describe, expect, test } from 'bun:test'
import {
  ACCEPT_THRESHOLD,
  MIN_LEAD,
  REVIEW_THRESHOLD,
  levenshtein,
  normalizeName,
  similarity,
} from '../src/services/matcher.ts'
import { checkQuality, richness } from '../src/services/quality.ts'
import { emptyCanonical } from '../src/normalize/contract.ts'

describe('name normalization', () => {
  test('drops the tagline stores append after a dash or colon', () => {
    expect(normalizeName('Duolingo - Language Lessons')).toBe('duolingo')
    expect(normalizeName('Notion: notes, docs, tasks')).toBe('notion')
  })

  test('folds accents, case and punctuation', () => {
    expect(normalizeName('Traducción Rápida!')).toBe('traduccion rapida')
    expect(normalizeName('WhatsApp Messenger')).toBe('whatsapp messenger')
  })

  test('drops the free/lite/pro qualifiers that differ between stores', () => {
    expect(normalizeName('Solitaire (Free)')).toBe('solitaire')
    expect(normalizeName('Sketch (Pro)')).toBe('sketch')
  })
})

describe('similarity', () => {
  test('identical names score 1', () => {
    expect(similarity('Google Translate', 'Google Translate')).toBe(1)
    expect(similarity('google translate', 'Google Translate')).toBe(1)
  })

  test('near misses score high', () => {
    // "translate" -> "translator" is two edits (e->o, plus r), not one.
    expect(similarity('Google Translate', 'Google Translator')).toBeGreaterThan(0.85)
    expect(similarity('WhatsApp', 'WhatsApp ')).toBe(1)
    expect(similarity('Spotify Music', 'Spotify Musik')).toBeGreaterThan(0.9)
  })

  test('hyphenated names are not truncated by the tagline rule', () => {
    // The separator rule must not eat half of "Wi-Fi Analyzer".
    expect(normalizeName('Wi-Fi Analyzer')).toBe('wi fi analyzer')
    expect(similarity('Wi-Fi Analyzer', 'WiFi Analyzer')).toBeGreaterThan(0.9)
  })

  test('unrelated names score low', () => {
    expect(similarity('Google Translate', 'Clash of Clans')).toBeLessThan(0.4)
  })

  test('empty input never throws and scores 0', () => {
    expect(similarity('', 'anything')).toBe(0)
    expect(similarity('翻訳', 'anything')).toBe(0)
  })

  test('levenshtein is symmetric and zero for identical strings', () => {
    expect(levenshtein('kitten', 'kitten')).toBe(0)
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('kitten', 'sitting')).toBe(levenshtein('sitting', 'kitten'))
  })
})

describe('matching thresholds', () => {
  test('the accept bar is well above the review bar', () => {
    expect(ACCEPT_THRESHOLD).toBeGreaterThan(REVIEW_THRESHOLD)
    expect(ACCEPT_THRESHOLD).toBeGreaterThanOrEqual(0.85)
  })

  test('a leader must actually lead', () => {
    // Two studios both publishing "Solitaire" is the normal case, not the edge
    // case. Without a required margin the first result would always win.
    expect(MIN_LEAD).toBeGreaterThan(0)
  })
})

describe('ingest quality gate', () => {
  test('rejects a record with no title', () => {
    const core = emptyCanonical()
    core.appId = 'com.example'
    core.description = 'x'.repeat(100)
    const verdict = checkQuality(core, 'play')
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('missing_title')
  })

  test('rejects a record with no id', () => {
    const core = emptyCanonical()
    core.title = 'Something'
    core.icon = 'https://example.com/icon.png'
    expect(checkQuality(core, 'play').reasons).toContain('missing_app_id')
  })

  test('rejects a listing with neither text nor imagery', () => {
    const core = emptyCanonical()
    core.title = 'Ghost App'
    core.appId = 'com.example.ghost'
    const verdict = checkQuality(core, 'play')
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('no_description_and_no_imagery')
  })

  test('accepts a listing with an icon but no description', () => {
    const core = emptyCanonical()
    core.title = 'Minimal App'
    core.appId = 'com.example.minimal'
    core.icon = 'https://example.com/icon.png'
    expect(checkQuality(core, 'play').ok).toBe(true)
  })

  test('accepts a listing with a description but no imagery', () => {
    const core = emptyCanonical()
    core.title = 'Wordy App'
    core.appId = 'com.example.wordy'
    core.description = 'A description long enough to be worth a page on its own.'
    expect(checkQuality(core, 'play').ok).toBe(true)
  })

  test('richness rises with substance', () => {
    const bare = emptyCanonical()
    bare.title = 'Bare'
    const full = emptyCanonical()
    full.title = 'Full'
    full.description = 'x'.repeat(300)
    full.descriptionHTML = '<p>x</p>'
    full.summary = 'A summary'
    full.icon = 'https://example.com/i.png'
    full.screenshots = ['a', 'b', 'c']
    full.score = 4.5
    full.ratings = 100
    full.developer = 'Dev'
    full.genre = 'Tools'
    full.categories = [{ name: 'Tools', id: 'TOOLS' }]
    full.contentRating = 'Everyone'
    full.updated = 1
    full.price = 0
    full.url = 'https://example.com'

    expect(richness(full)).toBeGreaterThan(richness(bare))
    expect(richness(full)).toBe(1)
  })
})
