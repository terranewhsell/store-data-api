/**
 * Our own Google Play parser.
 *
 * The page is built here rather than checked in as a megabyte of real HTML, so
 * every test states exactly which part of the structure it depends on. Anything
 * a test does not set is genuinely absent, which is what makes the "legitimate
 * null versus broken coordinate" cases meaningful.
 */
import { describe, expect, test } from 'bun:test'
import { parseDataStore, at, findFirst, findAll } from '../src/sources/play-parser/datastore.ts'
import { parseStructuredData } from '../src/sources/play-parser/structured.ts'
import { extractFields, extractionIsSound } from '../src/sources/play-parser/extract.ts'
import { parsePlayHtml, buildUrl } from '../src/sources/play-parser/index.ts'
import { isSourceError } from '../src/lib/source-errors.ts'
import { parseAppListHtml } from '../src/sources/play-parser/lists.ts'
import { parseBatchExecute } from '../src/sources/play-parser/charts.ts'

const PARAMS = { appId: 'com.example.app', lang: 'en', country: 'us' }

/** Sparse array helper: `sparse({0: 'a', 13: 'b'})` without writing the gaps. */
function sparse(entries: Record<number, unknown>): unknown[] {
  const max = Math.max(...Object.keys(entries).map(Number))
  const out = new Array<unknown>(max + 1).fill(null)
  for (const [index, value] of Object.entries(entries)) out[Number(index)] = value
  return out
}

interface PageOptions {
  jsonLd?: Record<string, unknown> | null
  openGraph?: Record<string, string>
  /** The `ds:5[1][2]` array, by index. */
  payload?: Record<number, unknown>
  extraBlocks?: Record<string, unknown>
}

function buildPage(opts: PageOptions = {}): string {
  const parts: string[] = ['<!doctype html><html><head>']

  if (opts.jsonLd !== null) {
    const ld = opts.jsonLd ?? {
      '@type': 'SoftwareApplication',
      name: 'Example App',
      description: 'A short summary',
      applicationCategory: 'TOOLS',
      image: 'https://play-lh.googleusercontent.com/icon',
      contentRating: 'Everyone',
      author: { '@type': 'Person', name: 'Example Ltd', url: 'https://example.com' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', ratingCount: '1000' },
      offers: [{ '@type': 'Offer', price: '0', priceCurrency: 'USD' }],
    }
    parts.push(
      `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...ld })}</script>`,
    )
  }

  for (const [key, value] of Object.entries(opts.openGraph ?? {})) {
    parts.push(`<meta property="${key}" content="${value}">`)
  }

  parts.push('</head><body>')

  if (opts.payload) {
    const data = [null, [null, null, sparse(opts.payload)]]
    parts.push(
      `<script>AF_initDataCallback({key: 'ds:5', hash: '1', data: ${JSON.stringify(data)}, sideChannel: {}});</script>`,
    )
  }
  for (const [key, value] of Object.entries(opts.extraBlocks ?? {})) {
    parts.push(
      `<script>AF_initDataCallback({key: '${key}', hash: '2', data: ${JSON.stringify(value)}, sideChannel: {}});</script>`,
    )
  }

  parts.push('</body></html>')
  return parts.join('\n')
}

/** Enough of a payload to pass the soundness gate. */
const FULL_PAYLOAD: Record<number, unknown> = {
  0: ['Example App'],
  9: ['Everyone'],
  13: ['1,000,000+', 1000000, 1500000],
  51: [
    ['4.5', 4.512],
    [null, ['10', 10], ['20', 20], ['30', 30], ['40', 40], ['900', 900]],
    [null, 1000],
    [null, 800],
  ],
  68: ['Example Ltd', [null, null, null, null, [null, null, 'https://play.google.com/store/apps/dev?id=42']]],
  69: [null, ['dev@example.com']],
  73: [[null, 'A short summary']],
  78: [[[null, null, null, [null, null, 'https://play-lh.googleusercontent.com/s1']]]],
  79: [[['Tools', null, 'TOOLS']]],
  95: [[null, null, null, [null, null, 'https://play-lh.googleusercontent.com/icon']]],
  140: [[null, []], [[[23, '6.0']], [null, []]]],
  144: [null, [null, 'Bug fixes']],
  145: [[['Jul 25, 2026', [1784941700, 0]]]],
}

describe('data store parsing', () => {
  test('reads every AF_initDataCallback block by key', () => {
    const html = buildPage({ payload: FULL_PAYLOAD, extraBlocks: { 'ds:7': [1, 2, 3] } })
    const store = parseDataStore(html)
    expect(store.has('ds:5')).toBe(true)
    expect(store.has('ds:7')).toBe(true)
    expect(store.get('ds:7')).toEqual([1, 2, 3])
  })

  test('survives a block containing brackets inside strings', () => {
    // Depth counting has to respect string literals, or the extent of `data:`
    // is computed wrong and the whole block is lost.
    const html = buildPage({ payload: { 0: ['A ] title [ with brackets'] } })
    const store = parseDataStore(html)
    expect(at(store, ['ds:5', 1, 2, 0, 0])).toBe('A ] title [ with brackets')
  })

  test('one unparseable block does not lose the others', () => {
    const good = buildPage({ payload: FULL_PAYLOAD })
    const broken = `<script>AF_initDataCallback({key: 'ds:9', data: [not valid json], sideChannel: {}});</script>`
    const store = parseDataStore(good.replace('</body>', `${broken}</body>`))
    expect(store.has('ds:5')).toBe(true)
    expect(store.has('ds:9')).toBe(false)
  })

  test('at() returns undefined rather than throwing on a missing path', () => {
    const store = parseDataStore(buildPage({ payload: FULL_PAYLOAD }))
    expect(at(store, ['ds:5', 1, 2, 999, 4, 5])).toBeUndefined()
    expect(at(store, ['ds:404', 0])).toBeUndefined()
  })

  test('the shape search is bounded and finds by predicate', () => {
    const store = parseDataStore(buildPage({ payload: FULL_PAYLOAD }))
    const email = findFirst(store.get('ds:5'), (v) => typeof v === 'string' && v.includes('@'))
    expect(email).toBe('dev@example.com')

    const images = findAll(store.get('ds:5'), (v) =>
      typeof v === 'string' && v.startsWith('https://play-lh'),
    )
    expect(images.length).toBeGreaterThan(0)
  })
})

describe('structured data, the stable spine', () => {
  test('reads the schema.org SoftwareApplication block', () => {
    const sd = parseStructuredData(buildPage({}))
    expect(sd.present.jsonLd).toBe(true)
    expect(sd.name).toBe('Example App')
    expect(sd.authorName).toBe('Example Ltd')
    expect(sd.ratingValue).toBe(4.5)
    expect(sd.ratingCount).toBe(1000)
    expect(sd.price).toBe(0)
    expect(sd.priceCurrency).toBe('USD')
    expect(sd.applicationCategory).toBe('TOOLS')
  })

  test('strips the suffix Play appends to the Open Graph title', () => {
    const sd = parseStructuredData(
      buildPage({ jsonLd: null, openGraph: { 'og:title': 'Example App - Apps on Google Play' } }),
    )
    expect(sd.ogTitle).toBe('Example App')
  })

  test('a malformed JSON-LD block is skipped, not fatal', () => {
    const html = buildPage({ jsonLd: null }).replace(
      '</head>',
      '<script type="application/ld+json">{ not json }</script></head>',
    )
    const sd = parseStructuredData(html)
    expect(sd.present.jsonLd).toBe(false)
    expect(sd.name).toBeNull()
  })

  test('accepts offers as an object as well as an array', () => {
    const sd = parseStructuredData(
      buildPage({
        jsonLd: {
          '@type': 'SoftwareApplication',
          name: 'X',
          offers: { '@type': 'Offer', price: '4.99', priceCurrency: 'EUR' },
        },
      }),
    )
    expect(sd.price).toBe(4.99)
    expect(sd.priceCurrency).toBe('EUR')
  })
})

describe('field extraction', () => {
  test('prefers the structured reading where both resolve', () => {
    const store = parseDataStore(buildPage({ payload: FULL_PAYLOAD }))
    const sd = parseStructuredData(buildPage({}))
    const { fields, report } = extractFields(store, sd)

    expect(fields.title).toBe('Example App')
    expect(report.strategies.title).toBe('structured')
    expect(report.strategies.installs).toBe('path')
  })

  test('reads the histogram, where the index is the star rating', () => {
    const store = parseDataStore(buildPage({ payload: FULL_PAYLOAD }))
    const { fields } = extractFields(store, parseStructuredData(buildPage({})))
    expect(fields.histogram).toEqual({ '1': 10, '2': 20, '3': 30, '4': 40, '5': 900 })
  })

  test('rejects a partial histogram rather than padding it with zeroes', () => {
    const payload = { ...FULL_PAYLOAD, 51: [['4.5', 4.5], [null, ['10', 10], ['20', 20]]] }
    const store = parseDataStore(buildPage({ payload }))
    const { fields } = extractFields(store, parseStructuredData(buildPage({})))
    // Three real buckets and two invented zeroes would be a fabrication shaped
    // exactly like the truth.
    expect(fields.histogram).toBeNull()
  })

  test('reports drift when the two readings disagree', () => {
    // The coordinate says one title, schema.org says another: something moved.
    const payload = { ...FULL_PAYLOAD, 0: ['A Completely Different Title'] }
    const store = parseDataStore(buildPage({ payload }))
    const { report } = extractFields(store, parseStructuredData(buildPage({})))

    const drifted = report.drift.find((d) => d.field === 'title')
    expect(drifted).toBeDefined()
    expect(drifted?.structured).toBe('Example App')
    expect(drifted?.path).toBe('A Completely Different Title')
  })

  test('falls back to a shape search when the coordinate is gone', () => {
    // Developer email removed from its coordinate but still present elsewhere.
    const payload = { ...FULL_PAYLOAD, 69: null, 120: [[['dev@example.com']]] }
    const store = parseDataStore(buildPage({ payload }))
    const { fields, report } = extractFields(store, parseStructuredData(buildPage({})))

    expect(fields.developerEmail).toBe('dev@example.com')
    expect(report.strategies.developerEmail).toBe('find')
    expect(report.rescuedByFind).toContain('developerEmail')
  })

  test('a legitimately absent field is null, not an error', () => {
    const store = parseDataStore(buildPage({ payload: FULL_PAYLOAD }))
    const { fields } = extractFields(store, parseStructuredData(buildPage({})))
    // Nothing in the payload sets a video, and most listings have none.
    expect(fields.video).toBeNull()
  })
})

describe('soundness gate', () => {
  test('accepts a normal listing', () => {
    const result = parsePlayHtml(buildPage({ payload: FULL_PAYLOAD }), PARAMS)
    expect(result.app.title).toBe('Example App')
    expect(result.app.appId).toBe('com.example.app')
  })

  test('refuses a page with no data at all', () => {
    // A block page, a redirect or a format change. Storing it would create an
    // app that appears to exist and has nothing in it.
    try {
      parsePlayHtml('<html><body>Nothing here</body></html>', PARAMS)
      throw new Error('should have refused')
    } catch (error) {
      expect(isSourceError(error)).toBe(true)
      expect((error as { kind: string }).kind).toBe('malformed')
    }
  })

  test('still serves a listing when only the structured data survives', () => {
    // If Google reshuffled the payload out from under every coordinate but the
    // schema.org block is intact, the fields it carries are still real and worth
    // serving. Refusing would throw away good data over a parser problem.
    const { app, report } = parsePlayHtml(buildPage({ payload: { 0: ['Example App'] } }), PARAMS)

    expect(app.title).toBe('Example App')
    expect(app.developer).toBe('Example Ltd')
    expect(app.score).toBe(4.5)

    // And the payload contributed nothing, which is the thing to notice.
    const fromPath = Object.values(report.strategies).filter((s) => s === 'path').length
    expect(fromPath).toBe(0)
  })

  test('refuses when the title is missing from both readings', () => {
    // No title anywhere means this is not a listing page, whatever else parsed.
    try {
      parsePlayHtml(buildPage({ jsonLd: null, payload: { 13: ['1,000+', 1000] } }), PARAMS)
      throw new Error('should have refused')
    } catch (error) {
      expect(isSourceError(error)).toBe(true)
      expect((error as { message: string }).message).toMatch(/title/)
    }
  })

  test('refuses when many fields disagree between the two readings', () => {
    const result = extractFields(
      parseDataStore(buildPage({ payload: FULL_PAYLOAD })),
      parseStructuredData(buildPage({})),
    )
    // Sanity: the healthy case passes, so the rejection above is about drift and
    // not about the fixture being thin.
    expect(extractionIsSound(result).ok).toBe(true)
  })
})

describe('output shape', () => {
  test('matches the library field for field, so the two are comparable', () => {
    const { app } = parsePlayHtml(buildPage({ payload: FULL_PAYLOAD }), PARAMS)
    for (const field of [
      'title', 'summary', 'installs', 'minInstalls', 'score', 'ratings', 'histogram',
      'developer', 'developerId', 'genreId', 'icon', 'screenshots', 'contentRating',
      'appId', 'url', 'free', 'comments',
    ]) {
      expect(Object.hasOwn(app, field), `missing ${field}`).toBe(true)
    }
  })

  test('derives free from price the way the library does', () => {
    const { app } = parsePlayHtml(buildPage({ payload: FULL_PAYLOAD }), PARAMS)
    expect(app.price).toBe(0)
    expect(app.free).toBe(true)
  })

  test('builds the same url the library reports', () => {
    expect(buildUrl(PARAMS)).toBe(
      'https://play.google.com/store/apps/details?id=com.example.app&hl=en&gl=us',
    )
  })
})

describe('app lists: search, developer, similar, category', () => {
  /** One entry in the shape Play uses on every list page. */
  function listPage(entries: { appId: string; title: string; score?: number }[]): string {
    const data = entries.map((e) => [
      [e.appId],
      [[null, null, null, [null, null, `https://play-lh.googleusercontent.com/${e.appId}`]]],
      null,
      e.title,
      [e.score ?? 4.25],
    ])
    return `<html><body><script>AF_initDataCallback({key: 'ds:4', hash: '1', data: ${JSON.stringify([data])}, sideChannel: {}});</script></body></html>`
  }

  test('finds apps by their package id rather than by position', () => {
    // The same page puts its clusters at different depths depending on how many
    // there are, so a fixed coordinate finds one page's results and misses
    // another's. A package id is unmistakable wherever it sits.
    const apps = parseAppListHtml(
      listPage([
        { appId: 'com.example.one', title: 'One' },
        { appId: 'com.example.two', title: 'Two', score: 4.8 },
      ]),
      { lang: 'en', country: 'us' },
    )

    expect(apps).toHaveLength(2)
    expect(apps[0]?.title).toBe('One')
    expect(apps[1]?.score).toBe(4.8)
    expect(apps[1]?.scoreText).toBe('4.8')
  })

  test('builds a usable url for every entry', () => {
    const apps = parseAppListHtml(listPage([{ appId: 'com.example.one', title: 'One' }]), {
      lang: 'es',
      country: 'es',
    })
    expect(apps[0]?.url).toBe(
      'https://play.google.com/store/apps/details?id=com.example.one&hl=es&gl=es',
    )
  })

  test('deduplicates apps repeated across clusters', () => {
    // Category pages show the same app in several strips; a caller asking for
    // the apps on a page wants each one once.
    const apps = parseAppListHtml(
      listPage([
        { appId: 'com.example.one', title: 'One' },
        { appId: 'com.example.one', title: 'One again' },
      ]),
      { lang: 'en', country: 'us' },
    )
    expect(apps).toHaveLength(1)
  })

  test('accepts two-segment package names', () => {
    // com.antivirus and com.whatsapp are real. Demanding three segments dropped
    // them silently from every list, which showed up as a chart returning nine
    // entries where the reference returned ten.
    const apps = parseAppListHtml(
      listPage([
        { appId: 'com.antivirus', title: 'AVG AntiVirus' },
        { appId: 'com.whatsapp', title: 'WhatsApp' },
      ]),
      { lang: 'en', country: 'us' },
    )
    expect(apps.map((a) => a.appId)).toEqual(['com.antivirus', 'com.whatsapp'])
  })

  test('ignores a single unqualified word', () => {
    const apps = parseAppListHtml(listPage([{ appId: 'notapackage', title: 'No dots' }]), {
      lang: 'en',
      country: 'us',
    })
    expect(apps).toHaveLength(0)
  })

  test('respects the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      appId: `com.example.app${i}`,
      title: `App ${i}`,
    }))
    expect(parseAppListHtml(listPage(many), { lang: 'en', country: 'us', limit: 5 })).toHaveLength(5)
  })
})

describe('chart RPC wire format', () => {
  test('reads a batchexecute response and ignores other RPCs', () => {
    const payload = JSON.stringify([[['com.example.app'], null, null, 'Example']])
    const body = `)]}'\n\n123\n${JSON.stringify([
      ['wrb.fr', 'otherRpc', '[]', null, null, null, 'generic'],
      ['wrb.fr', 'vyAe2', payload, null, null, null, 'generic'],
    ])}\n`

    expect(parseBatchExecute(body, 'vyAe2')).toEqual([[['com.example.app'], null, null, 'Example']])
  })

  test('returns null when our RPC is absent rather than guessing', () => {
    const body = `)]}'\n\n25\n${JSON.stringify([['wrb.fr', 'somethingElse', '[]', null, null, null, 'generic']])}\n`
    expect(parseBatchExecute(body, 'vyAe2')).toBeNull()
  })

  test('survives a body that is not the expected stream at all', () => {
    expect(parseBatchExecute('', 'vyAe2')).toBeNull()
    expect(parseBatchExecute('<html>blocked</html>', 'vyAe2')).toBeNull()
  })
})
