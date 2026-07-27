/**
 * Response envelope.
 *
 * Copied field for field from the coupons API, which their team already parses:
 *
 *   paginated:   version, generated_at, lang, total, pages, page, per_page, items
 *   unpaginated: version, generated_at, lang, total, items
 *
 * One additive change, and only one: `country` sits next to `lang`. The coupons
 * feed is single-market so `lang` alone identified it; here the data depends on
 * country AND language, and a consumer that cannot tell which market it received
 * cannot cache or compare anything. Nothing is renamed or removed, so an existing
 * parser keeps working.
 */
export const API_VERSION = 'v1'

export interface EnvelopeMarket {
  lang: string
  country: string
}

export interface BaseEnvelope<T> {
  version: string
  generated_at: string
  lang: string
  country: string
  total: number
  items: T[]
}

export interface PaginatedEnvelope<T> extends BaseEnvelope<T> {
  pages: number
  page: number
  per_page: number
}

/** ISO 8601 with offset, same format as the coupons API `generated_at`. */
export function isoNow(date: Date = new Date()): string {
  return toIso(date)
}

export function toIso(date: Date): string {
  // Node/Bun render `toISOString()` as ...Z; the coupons API renders +00:00.
  // Same instant, same standard, but we keep their exact spelling.
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

export function envelope<T>(
  items: T[],
  opts: { total: number; market: EnvelopeMarket; generatedAt?: Date },
): BaseEnvelope<T> {
  return {
    version: API_VERSION,
    generated_at: isoNow(opts.generatedAt),
    lang: opts.market.lang,
    country: opts.market.country,
    total: opts.total,
    items,
  }
}

export function paginatedEnvelope<T>(
  items: T[],
  opts: {
    total: number
    page: number
    perPage: number
    market: EnvelopeMarket
    generatedAt?: Date
  },
): PaginatedEnvelope<T> {
  return {
    version: API_VERSION,
    generated_at: isoNow(opts.generatedAt),
    lang: opts.market.lang,
    country: opts.market.country,
    total: opts.total,
    pages: opts.perPage > 0 ? Math.ceil(opts.total / opts.perPage) : 0,
    page: opts.page,
    per_page: opts.perPage,
    items,
  }
}
