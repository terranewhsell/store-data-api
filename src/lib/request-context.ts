/**
 * Query parameters shared by every route: market, source filter, type filter.
 *
 * Market resolution is permissive on purpose. A malformed `country=USA` falls
 * back to the default rather than returning a 400: the client's coupons API
 * behaves that way for pagination, and a listing endpoint that 400s on a typo is
 * a listing endpoint that breaks a whole page over one bad link.
 */
import type { Context } from 'hono'
import { config } from '../config.ts'
import { normalizeCountry, normalizeLang } from '../data/markets.ts'
import { SOURCES, type Source } from '../normalize/contract.ts'
import { badRequest } from './errors.ts'

export interface Market {
  country: string
  lang: string
}

export function resolveMarket(c: Context): Market {
  return {
    country: normalizeCountry(c.req.query('country'), config.DEFAULT_COUNTRY),
    lang: normalizeLang(c.req.query('lang'), config.DEFAULT_LANG),
  }
}

/**
 * `?source=play,ios`. An empty list means "every source", which is what
 * `/v1/apps` returns by default.
 */
export function resolveSources(c: Context, allowed: readonly Source[] = SOURCES): Source[] {
  const raw = c.req.query('source')
  if (!raw || raw.trim() === '') return []

  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)

  const invalid = requested.filter((s) => !(allowed as readonly string[]).includes(s))
  if (invalid.length > 0) {
    throw badRequest(
      `Unknown source: ${invalid.join(', ')}. Allowed here: ${allowed.join(', ')}.`,
      { allowed: [...allowed] },
    )
  }
  return requested as Source[]
}

export function resolveType(c: Context): 'app' | 'game' | undefined {
  const raw = c.req.query('type')?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw !== 'app' && raw !== 'game') {
    throw badRequest('type must be either "app" or "game".')
  }
  return raw
}

export function resolveBool(c: Context, name: string, dflt = false): boolean {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return dflt
  return raw === '1' || raw.toLowerCase() === 'true'
}

const SORTS = ['score', 'ratings', 'updated', 'title', 'price'] as const
export type ListSort = (typeof SORTS)[number]

export function resolveSort(c: Context): { sort: ListSort; order: 'asc' | 'desc' } {
  const rawSort = c.req.query('sort_by')?.trim().toLowerCase()
  const sort = (SORTS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as ListSort)
    : 'score'

  const rawOrder = c.req.query('order')?.trim().toLowerCase()
  const order = rawOrder === 'asc' ? 'asc' : 'desc'
  return { sort, order }
}
