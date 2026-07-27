/**
 * GET /v1/export/apps
 *
 * Bulk export for a static site build.
 *
 * A generator that walks tens of thousands of listings with `page`/`per_page`
 * gets slower on every page, and worse, can skip or duplicate rows whenever an
 * ingest writes something mid-crawl. So this route uses a keyset cursor over
 * (last_changed_at, id), which is unique, monotonic and unaffected by concurrent
 * writes.
 *
 * `?since=` filters on `last_changed_at`, not `fetched_at`. A refresh that
 * returned byte-identical data does not move `last_changed_at`, so an incremental
 * build rebuilds only the pages whose content actually changed instead of all of
 * them on every refresh.
 *
 * Typical use:
 *   full build:        /v1/export/apps?limit=500                then follow next_cursor
 *   incremental build: /v1/export/apps?since=<last build time>  then follow next_cursor
 */
import { Hono } from 'hono'
import { badRequest } from '../../lib/errors.ts'
import { API_VERSION, isoNow } from '../../lib/envelope.ts'
import { resolveBool, resolveMarket, resolveSources } from '../../lib/request-context.ts'
import { exportApps, type ExportCursor } from '../../services/reads.ts'

/** Higher than the listing cap: this route exists to move volume. */
const MAX_EXPORT_LIMIT = 1000
const DEFAULT_EXPORT_LIMIT = 250

function parseCursor(raw: string | undefined): ExportCursor | undefined {
  if (!raw || raw.trim() === '') return undefined
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ExportCursor
    if (typeof decoded.lastChangedAt !== 'string' || typeof decoded.id !== 'number') {
      throw new Error('shape')
    }
    return decoded
  } catch {
    throw badRequest('Invalid cursor. Pass back the `next_cursor` value verbatim.')
  }
}

function encodeCursor(cursor: ExportCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export const exportRoutes = new Hono()

exportRoutes.get('/export/apps', async (c) => {
  const market = resolveMarket(c)
  const sources = resolveSources(c)

  const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_EXPORT_LIMIT, rawLimit))
    : DEFAULT_EXPORT_LIMIT

  const rawSince = c.req.query('since')?.trim()
  let since: Date | undefined
  if (rawSince) {
    const parsed = new Date(rawSince)
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest('`since` must be an ISO 8601 timestamp, for example 2026-07-26T22:00:00Z.')
    }
    since = parsed
  }

  const result = await exportApps({
    country: market.country,
    lang: market.lang,
    sources,
    ...(since ? { since } : {}),
    ...(parseCursor(c.req.query('cursor')) ? { cursor: parseCursor(c.req.query('cursor')) as ExportCursor } : {}),
    limit,
    // Delisted apps are included by default here, unlike in the listing routes.
    // A build needs to know an app went away so it can update or retire the page;
    // silently dropping it leaves a stale page nobody knows to remove.
    includeDelisted: resolveBool(c, 'include_delisted', true),
  })

  return c.json({
    version: API_VERSION,
    generated_at: isoNow(),
    lang: market.lang,
    country: market.country,
    count: result.items.length,
    has_more: result.hasMore,
    next_cursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    ...(since ? { since: since.toISOString() } : {}),
    items: result.items,
  })
})
