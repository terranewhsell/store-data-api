/**
 * The stable spine: schema.org data Google Play publishes for search engines.
 *
 * WHY THIS EXISTS AND WHY IT COMES FIRST
 *
 * The usual way to parse Google Play is to walk the obfuscated `AF_initDataCallback`
 * payload with hardcoded numeric coordinates: title at `['ds:5', 1, 2, 0, 0]`, and
 * so on. That is what google-play-scraper does, and it is why any Play scraper
 * needs constant maintenance: Google reorders that array whenever it feels like
 * it, every coordinate breaks at once, and the parser starts returning undefined
 * for everything without noticing.
 *
 * But the same page also carries a JSON-LD `SoftwareApplication` block, Open
 * Graph tags and microdata. Those are a published contract with search engines.
 * Google renders its own rich results from them, so breaking their shape costs
 * Google something, which is exactly the property a scraping target normally
 * lacks. They are dramatically more stable than array indices.
 *
 * They do not cover everything, so the coordinate walk is still needed for the
 * rest. What changes is the relationship: the structured data is the foundation
 * and the coordinates are a supplement, instead of the coordinates being
 * everything.
 *
 * The second benefit matters as much as the first. Two independent readings of
 * the same page can be COMPARED. When the coordinates drift, their title stops
 * matching the JSON-LD name, and we know before anything is stored. A parser
 * that can tell it is broken is worth more than one that is merely correct today.
 */
import { decodeEntities } from '../../lib/html.ts'

export interface StructuredData {
  /** schema.org SoftwareApplication, when present. */
  name: string | null
  description: string | null
  url: string | null
  image: string | null
  applicationCategory: string | null
  operatingSystem: string | null
  contentRating: string | null
  authorName: string | null
  authorUrl: string | null
  ratingValue: number | null
  ratingCount: number | null
  price: number | null
  priceCurrency: string | null

  /** Open Graph, as a second opinion on the same few fields. */
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null
  ogUrl: string | null

  /** Which of the three sources actually yielded anything. */
  present: { jsonLd: boolean; openGraph: boolean; microdata: boolean }
}

export function emptyStructured(): StructuredData {
  return {
    name: null,
    description: null,
    url: null,
    image: null,
    applicationCategory: null,
    operatingSystem: null,
    contentRating: null,
    authorName: null,
    authorUrl: null,
    ratingValue: null,
    ratingCount: null,
    price: null,
    priceCurrency: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    ogUrl: null,
    present: { jsonLd: false, openGraph: false, microdata: false },
  }
}

const JSON_LD = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
const META = /<meta\s+(?:property|name)="(og:[a-z:]+)"\s+content="([^"]*)"/gi

/**
 * Play appends " - Apps on Google Play" to the Open Graph title. The JSON-LD
 * `name` is clean, so this only matters when falling back to og:title.
 */
const OG_TITLE_SUFFIX = /\s*[-–]\s*Apps on Google Play\s*$/i

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const decoded = decodeEntities(value).trim()
  return decoded.length > 0 ? decoded : null
}

/** The first `offers` entry, whether Google emitted an object or an array. */
function firstOffer(offers: unknown): Record<string, unknown> | null {
  if (Array.isArray(offers)) {
    const first = offers.find((o) => o !== null && typeof o === 'object')
    return (first as Record<string, unknown>) ?? null
  }
  if (offers !== null && typeof offers === 'object') return offers as Record<string, unknown>
  return null
}

export function parseStructuredData(html: string): StructuredData {
  const out = emptyStructured()

  // ---- JSON-LD -----------------------------------------------------------
  JSON_LD.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = JSON_LD.exec(html)) !== null) {
    const body = match[1]
    if (!body) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // A malformed block is not fatal: the coordinate walk still runs, and the
      // absence is reported in `present` so a caller can see the spine is thin.
      continue
    }

    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') continue
      const record = candidate as Record<string, unknown>
      if (record['@type'] !== 'SoftwareApplication') continue

      out.present.jsonLd = true
      out.name = str(record.name)
      out.description = str(record.description)
      out.url = str(record.url)
      out.image = str(record.image)
      out.applicationCategory = str(record.applicationCategory)
      out.operatingSystem = str(record.operatingSystem)
      out.contentRating = str(record.contentRating)

      const author = record.author as Record<string, unknown> | undefined
      if (author) {
        out.authorName = str(author.name)
        out.authorUrl = str(author.url)
      }

      const rating = record.aggregateRating as Record<string, unknown> | undefined
      if (rating) {
        out.ratingValue = num(rating.ratingValue)
        out.ratingCount = num(rating.ratingCount)
      }

      const offer = firstOffer(record.offers)
      if (offer) {
        out.price = num(offer.price)
        out.priceCurrency = str(offer.priceCurrency)
      }
    }
  }

  // ---- Open Graph --------------------------------------------------------
  META.lastIndex = 0
  while ((match = META.exec(html)) !== null) {
    const property = match[1]
    const content = str(match[2])
    if (content === null) continue
    out.present.openGraph = true

    if (property === 'og:title') out.ogTitle = content.replace(OG_TITLE_SUFFIX, '').trim() || null
    else if (property === 'og:description') out.ogDescription = content
    else if (property === 'og:image') out.ogImage = content
    else if (property === 'og:url') out.ogUrl = content
  }

  out.present.microdata = /itemprop="(?:name|starRating|contentRating)"/.test(html)

  return out
}

/**
 * The two independent readings of the same field, for drift detection.
 *
 * A caller compares this against whatever the coordinate walk produced. Neither
 * being present is not an error; the point is that when both are present and
 * they DISAGREE, something has moved and the coordinates are the suspect.
 */
export function structuredTitle(data: StructuredData): string | null {
  return data.name ?? data.ogTitle
}

export function structuredIcon(data: StructuredData): string | null {
  return data.image ?? data.ogImage
}
