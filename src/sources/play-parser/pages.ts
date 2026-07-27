/**
 * Search, developer catalogue and similar apps, from ordinary HTML pages.
 *
 * All three are served as normal pages carrying the same `AF_initDataCallback`
 * payload as a listing, so all three go through the same shape-based list
 * extractor. No RPC, no opaque request body, nothing transcribed.
 *
 * Verified against live pages: search returns 30 entries, a developer page 11,
 * a category page 22, each with title, package id, icon and score.
 */
import { config } from '../../config.ts'
import { fetchText } from '../../lib/http.ts'
import { pacers } from '../../lib/pacer.ts'
import { SourceError } from '../../lib/source-errors.ts'
import { parseAppListHtml, type ListedApp } from './lists.ts'

const STORE = 'https://play.google.com/store'

export interface PageParams {
  lang: string
  country: string
  num?: number
}

/**
 * Play serves a reduced page to clients that do not look like a browser, and the
 * reduced page carries no data payload at all. Asking for HTML explicitly is
 * what makes the difference.
 */
const PAGE_HEADERS = { accept: 'text/html,application/xhtml+xml' }

async function fetchPage(url: string, context: Record<string, unknown>): Promise<string> {
  try {
    const html = await pacers.play.run(() =>
      fetchText('play', url, { timeoutMs: config.HTTP_TIMEOUT_MS, headers: PAGE_HEADERS }),
    )
    pacers.play.recordSuccess()
    return html
  } catch (error) {
    if (error instanceof SourceError) pacers.play.recordFailure(error)
    throw error
  }
}

function requireApps(
  apps: ListedApp[],
  what: string,
  context: Record<string, unknown>,
): ListedApp[] {
  if (apps.length > 0) return apps
  // Zero results from a page that should have some is a format change or a
  // block, not an empty catalogue. Reporting it as "no results" would be the
  // quiet failure this parser exists to prevent.
  const error = new SourceError('play', 'malformed', `Play ${what} page yielded no apps.`, {
    detail: context,
  })
  pacers.play.recordFailure(error)
  throw error
}

export async function search(term: string, params: PageParams): Promise<ListedApp[]> {
  const qs = new URLSearchParams({
    q: term,
    c: 'apps',
    hl: params.lang,
    gl: params.country,
  })
  const url = `${STORE}/search?${qs.toString()}`
  const html = await fetchPage(url, { term })

  const apps = parseAppListHtml(html, {
    lang: params.lang,
    country: params.country,
    ...(params.num !== undefined ? { limit: params.num } : {}),
  })

  // A search with genuinely no matches is a real answer, so this one does not
  // insist on results. The others do.
  return apps
}

export async function developerApps(devId: string, params: PageParams): Promise<ListedApp[]> {
  const qs = new URLSearchParams({ id: devId, hl: params.lang, gl: params.country })
  const url = `${STORE}/apps/dev?${qs.toString()}`
  const html = await fetchPage(url, { devId })

  const apps = parseAppListHtml(html, {
    lang: params.lang,
    country: params.country,
    ...(params.num !== undefined ? { limit: params.num } : {}),
  })
  return requireApps(apps, 'developer', { devId })
}

/**
 * Apps Play shows alongside a listing.
 *
 * Read from the listing page itself: the "similar" strip is rendered with the
 * rest of the page, so it costs no extra request. The app being viewed is
 * filtered out of its own recommendations.
 */
export async function similarApps(appId: string, params: PageParams): Promise<ListedApp[]> {
  const qs = new URLSearchParams({ id: appId, hl: params.lang, gl: params.country })
  const url = `${STORE}/apps/details?${qs.toString()}`
  const html = await fetchPage(url, { appId })

  const apps = parseAppListHtml(html, {
    lang: params.lang,
    country: params.country,
    limit: (params.num ?? 50) + 1,
  })
  return apps.filter((app) => app.appId !== appId)
}

/**
 * Apps on a category page.
 *
 * Not a ranked chart: Play loads the ordered charts separately (see charts.ts).
 * This is the mixed set the category page itself renders, which is useful for
 * discovery and is not presented as a ranking anywhere.
 */
export async function categoryApps(categoryId: string, params: PageParams): Promise<ListedApp[]> {
  const qs = new URLSearchParams({ hl: params.lang, gl: params.country })
  const url = `${STORE}/apps/category/${encodeURIComponent(categoryId)}?${qs.toString()}`
  const html = await fetchPage(url, { categoryId })

  const apps = parseAppListHtml(html, {
    lang: params.lang,
    country: params.country,
    ...(params.num !== undefined ? { limit: params.num } : {}),
  })
  return requireApps(apps, 'category', { categoryId })
}
