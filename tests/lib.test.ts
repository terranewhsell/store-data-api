/**
 * The pieces the client's existing integration depends on: the error shape, the
 * envelope, the pagination clamps, entity decoding, and the permanence of slugs.
 */
import { describe, expect, test } from 'bun:test'
import { extractBearer, readToken, tokensMatch } from '../src/lib/auth.ts'
import { envelope, paginatedEnvelope, toIso } from '../src/lib/envelope.ts'
import { noTokenConfigured, unauthorized, badRequest } from '../src/lib/errors.ts'
import { decodeEntities, toPlainText } from '../src/lib/html.ts'
import { parsePageParams } from '../src/lib/pagination.ts'
import { appSlug, disambiguateSlug, slugify } from '../src/lib/slug.ts'
import { SlidingWindowLimiter, callerKey } from '../src/lib/rate-limit.ts'

describe('error shape', () => {
  test('matches the WP_Error form the coupons API already returns', () => {
    const body = unauthorized().toBody()
    expect(Object.keys(body).sort()).toEqual(['code', 'data', 'message'])
    expect(body.data.status).toBe(401)
    expect(typeof body.code).toBe('string')
    expect(typeof body.message).toBe('string')
  })

  test('a missing server token is 503, not 401', () => {
    // "You are not authorized" and "this service is misconfigured" are different
    // problems and the caller has to be able to tell them apart.
    const body = noTokenConfigured().toBody()
    expect(body.data.status).toBe(503)
    expect(body.code).toBe('store_no_token_configured')
  })

  test('messages are in English, unlike the WordPress plugin', () => {
    for (const error of [unauthorized(), noTokenConfigured(), badRequest('Bad thing.')]) {
      expect(error.message).toMatch(/^[\x20-\x7E]+$/)
    }
  })
})

describe('bearer parsing', () => {
  test('accepts the standard header, case-insensitively', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123')
    expect(extractBearer('bearer abc123')).toBe('abc123')
    expect(extractBearer('BEARER abc123')).toBe('abc123')
    expect(extractBearer('  Bearer   abc123  ')).toBe('abc123')
  })

  test('rejects anything else', () => {
    expect(extractBearer(undefined)).toBeNull()
    expect(extractBearer('')).toBeNull()
    expect(extractBearer('Basic abc123')).toBeNull()
    expect(extractBearer('Bearer')).toBeNull()
    expect(extractBearer('Bearer   ')).toBeNull()
  })

  test('falls back to the configured header when the proxy ate the first', () => {
    const headers: Record<string, string> = { 'x-authorization': 'Bearer fallback' }
    expect(readToken((name) => headers[name], 'x-authorization')).toBe('fallback')
  })

  test('prefers the canonical header when both are present', () => {
    const headers: Record<string, string> = {
      authorization: 'Bearer primary',
      'x-authorization': 'Bearer fallback',
    }
    expect(readToken((name) => headers[name], 'x-authorization')).toBe('primary')
  })
})

describe('token comparison', () => {
  test('matches equal tokens and rejects different ones', () => {
    expect(tokensMatch('secret', 'secret')).toBe(true)
    expect(tokensMatch('secret', 'secrec')).toBe(false)
  })

  test('does not throw on different lengths', () => {
    // timingSafeEqual throws on unequal buffer lengths, and that exception alone
    // would leak the token length. Both sides are hashed first, so this is safe.
    expect(tokensMatch('a', 'a-much-longer-token')).toBe(false)
    expect(tokensMatch('', 'x')).toBe(false)
  })
})

describe('response envelope', () => {
  const market = { lang: 'en', country: 'us' }

  test('paginated form carries the coupons fields plus country', () => {
    const body = paginatedEnvelope([1, 2], { total: 13987, page: 1, perPage: 2, market })
    expect(Object.keys(body)).toEqual([
      'version', 'generated_at', 'lang', 'country', 'total', 'pages', 'page',
      'per_page', 'items',
    ])
    expect(body.version).toBe('v1')
    expect(body.total).toBe(13987)
    expect(body.pages).toBe(6994)
  })

  test('unpaginated form drops pages, page and per_page', () => {
    const body = envelope([1], { total: 1, market })
    expect(Object.keys(body)).toEqual([
      'version', 'generated_at', 'lang', 'country', 'total', 'items',
    ])
    expect(body).not.toHaveProperty('pages')
    expect(body).not.toHaveProperty('per_page')
  })

  test('generated_at is spelled the way the coupons API spells it', () => {
    expect(toIso(new Date('2026-07-26T22:21:02.000Z'))).toBe('2026-07-26T22:21:02+00:00')
  })
})

describe('pagination clamps', () => {
  test('per_page is max(1, min(200, value))', () => {
    expect(parsePageParams({ per_page: '500' }).perPage).toBe(200)
    expect(parsePageParams({ per_page: '0' }).perPage).toBe(1)
    expect(parsePageParams({ per_page: '-10' }).perPage).toBe(1)
    expect(parsePageParams({ per_page: '25' }).perPage).toBe(25)
  })

  test('page is max(1, value)', () => {
    expect(parsePageParams({ page: '0' }).page).toBe(1)
    expect(parsePageParams({ page: '-3' }).page).toBe(1)
    expect(parsePageParams({ page: '7' }).page).toBe(7)
  })

  test('garbage falls back to the default instead of erroring', () => {
    // A bad ?page=abc should still return page 1. A 400 there breaks a whole
    // page over one malformed link.
    expect(parsePageParams({ page: 'abc' }).page).toBe(1)
    expect(parsePageParams({ per_page: 'abc' }).perPage).toBe(50)
  })

  test('offset follows from page and per_page', () => {
    expect(parsePageParams({ page: '3', per_page: '20' }).offset).toBe(40)
  })
})

describe('html entity decoding', () => {
  test('decodes the exact case the client reported', () => {
    expect(decodeEntities('It&#8217;s here')).toBe('It’s here')
  })

  test('handles named, decimal and hex forms', () => {
    expect(decodeEntities('&amp; &lt; &gt; &quot;')).toBe('& < > "')
    expect(decodeEntities('&#233;')).toBe('é')
    expect(decodeEntities('&#x2014;')).toBe('—')
  })

  test('handles double encoding', () => {
    expect(decodeEntities('&amp;#8217;')).toBe('’')
  })

  test('leaves unknown entities alone rather than mangling them', () => {
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;')
  })

  test('toPlainText strips markup and keeps line structure', () => {
    expect(toPlainText('<p>One</p><p>Two &amp; three</p>')).toBe('One\nTwo & three')
    expect(toPlainText('Line<br>Break')).toBe('Line\nBreak')
  })
})

describe('permanent slugs', () => {
  test('readable and stable for ordinary titles', () => {
    expect(slugify('Google Translate')).toBe('google-translate')
    expect(slugify('Clash of Clans')).toBe('clash-of-clans')
    expect(slugify('  Spaces   Everywhere  ')).toBe('spaces-everywhere')
  })

  test('accents are folded, punctuation dropped', () => {
    expect(slugify('Traducción Rápida')).toBe('traduccion-rapida')
    expect(slugify('Angry Birds 2!')).toBe('angry-birds-2')
  })

  test('ampersands and plus signs become words, not gaps', () => {
    expect(slugify('Fish & Chips')).toBe('fish-and-chips')
    expect(slugify('Notes+')).toBe('notes-plus')
  })

  test('a title in a non-latin script still gets a usable slug', () => {
    const slug = appSlug({ title: '翻訳アプリ', source: 'play', sourceId: 'com.example.jp' })
    expect(slug.length).toBeGreaterThan(2)
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })

  test('the same app always produces the same slug', () => {
    const input = { title: 'Google Translate', source: 'play', sourceId: 'com.google.translate' }
    expect(appSlug(input)).toBe(appSlug(input))
    expect(disambiguateSlug('google-translate', 'play', 'com.google.translate')).toBe(
      disambiguateSlug('google-translate', 'play', 'com.google.translate'),
    )
  })

  test('disambiguation differs per app but never per call', () => {
    const a = disambiguateSlug('solitaire', 'play', 'com.a.solitaire')
    const b = disambiguateSlug('solitaire', 'play', 'com.b.solitaire')
    expect(a).not.toBe(b)
    expect(a).toStartWith('solitaire-')
    expect(b).toStartWith('solitaire-')
  })
})

describe('rate limiting', () => {
  test('allows up to the limit, then refuses with a retry hint', () => {
    const limiter = new SlidingWindowLimiter(3, 60_000)
    expect(limiter.check('caller').allowed).toBe(true)
    expect(limiter.check('caller').allowed).toBe(true)
    expect(limiter.check('caller').allowed).toBe(true)

    const blocked = limiter.check('caller')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })

  test('callers are independent', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000)
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('b').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
  })

  test('the window slides', () => {
    const limiter = new SlidingWindowLimiter(1, 1000)
    const t0 = 1_000_000
    expect(limiter.check('a', t0).allowed).toBe(true)
    expect(limiter.check('a', t0 + 500).allowed).toBe(false)
    expect(limiter.check('a', t0 + 1500).allowed).toBe(true)
  })

  test('token identity beats shared IP', () => {
    const byToken = callerKey({ authorization: 'Bearer abc', forwardedFor: '1.2.3.4' })
    const byOtherToken = callerKey({ authorization: 'Bearer xyz', forwardedFor: '1.2.3.4' })
    expect(byToken).not.toBe(byOtherToken)
    expect(byToken).toStartWith('t:')
    // The token itself never becomes the key.
    expect(byToken).not.toContain('abc')
  })

  test('falls back to the first forwarded address', () => {
    expect(callerKey({ forwardedFor: '9.9.9.9, 10.0.0.1' })).toBe('ip:9.9.9.9')
  })
})
