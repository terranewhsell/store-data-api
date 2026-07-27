/**
 * Markets.
 *
 * The client asked for "all markets if possible". Structurally that is already
 * true: country and language are part of the key everywhere, so any ISO country
 * and any language can be stored and served.
 *
 * What is tiered is INGESTION, not support. Each market is a full extra pass over
 * every app, and Google Play is the source that blocks. Tier 1 is warmed on a
 * schedule; anything else is fetched on demand the first time it is asked for and
 * cached from then on. That delivers "all markets" honestly, without promising a
 * refresh rate nobody measured.
 */
export interface Market {
  country: string
  lang: string
  label: string
}

/** Warmed by the scheduled ingest. Everything else is cold-start on demand. */
export const TIER_1_MARKETS: readonly Market[] = Object.freeze([
  { country: 'us', lang: 'en', label: 'United States' },
  { country: 'gb', lang: 'en', label: 'United Kingdom' },
  { country: 'es', lang: 'es', label: 'Spain' },
  { country: 'mx', lang: 'es', label: 'Mexico' },
  { country: 'ar', lang: 'es', label: 'Argentina' },
  { country: 'br', lang: 'pt', label: 'Brazil' },
  { country: 'de', lang: 'de', label: 'Germany' },
  { country: 'fr', lang: 'fr', label: 'France' },
  { country: 'it', lang: 'it', label: 'Italy' },
  { country: 'ca', lang: 'en', label: 'Canada' },
  { country: 'au', lang: 'en', label: 'Australia' },
  { country: 'in', lang: 'en', label: 'India' },
  { country: 'jp', lang: 'ja', label: 'Japan' },
  { country: 'kr', lang: 'ko', label: 'South Korea' },
])

const TIER_1_KEYS = new Set(TIER_1_MARKETS.map((m) => `${m.country}:${m.lang}`))

export function isTier1(country: string, lang: string): boolean {
  return TIER_1_KEYS.has(`${country}:${lang}`)
}

/**
 * When a market has not been ingested yet we can still answer from the closest
 * warmed market, as long as we say so in `_meta`. Preference is same language
 * first, then the default market.
 */
export function nearestWarmMarket(country: string, lang: string): Market {
  const sameLang = TIER_1_MARKETS.find((m) => m.lang === lang)
  if (sameLang) return sameLang
  const sameCountry = TIER_1_MARKETS.find((m) => m.country === country)
  if (sameCountry) return sameCountry
  return TIER_1_MARKETS[0] as Market
}

const COUNTRY_RE = /^[a-z]{2}$/
const LANG_RE = /^[a-z]{2}(-[a-z0-9]{2,8})?$/

export function normalizeCountry(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim().toLowerCase()
  return COUNTRY_RE.test(v) ? v : fallback
}

export function normalizeLang(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim().toLowerCase()
  return LANG_RE.test(v) ? v : fallback
}
