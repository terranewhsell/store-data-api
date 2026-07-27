/**
 * Pagination clamps, identical to the coupons API:
 *   per_page = max(1, min(200, value))
 *   page     = max(1, value)
 *
 * Anything unparseable falls back to the default rather than erroring: a bad
 * `?page=abc` should still return page 1, not a 400. That is how the coupons
 * API behaves and consumers rely on it.
 */
import { config } from '../config.ts'

export interface PageParams {
  page: number
  perPage: number
  offset: number
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

export function parsePageParams(
  query: { page?: string; per_page?: string },
  opts: { defaultPerPage?: number; maxPerPage?: number } = {},
): PageParams {
  const maxPerPage = opts.maxPerPage ?? config.MAX_PER_PAGE
  const defaultPerPage = opts.defaultPerPage ?? config.DEFAULT_PER_PAGE

  const perPage = Math.max(1, Math.min(maxPerPage, toInt(query.per_page, defaultPerPage)))
  const page = Math.max(1, toInt(query.page, 1))

  return { page, perPage, offset: (page - 1) * perPage }
}
