/**
 * App lists: search results, developer catalogues, similar apps, category
 * clusters.
 *
 * All of these arrive on ordinary HTML pages carrying the same
 * `AF_initDataCallback` payload as a listing, so one extractor serves all four.
 *
 * The extraction is shape-based rather than coordinate-based, and here that is
 * not merely more robust, it is necessary: the same page puts its clusters at
 * different depths depending on how many there are, so a fixed coordinate finds
 * one page's results and misses another's. What every entry does have in common
 * is an Android package name, and a package name is unmistakable: three or more
 * dot-separated lowercase segments. Anchoring on that and reading the
 * neighbouring fields works across all four page types and survives a
 * reshuffle.
 */
import { decodeEntities } from '../../lib/html.ts'
import { parseDataStore, type DataStore } from './datastore.ts'

/** `com.example.app`, at least three segments. */
const PACKAGE_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/i

export interface ListedApp {
  appId: string
  title: string | null
  developer: string | null
  icon: string | null
  score: number | null
  scoreText: string | null
  price: number | null
  currency: string | null
  free: boolean | null
  url: string
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const decoded = decodeEntities(value).trim()
  return decoded.length > 0 ? decoded : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The first play-lh image anywhere inside an entry: its icon. */
function findIcon(node: unknown, depth = 0): string | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null
  if (typeof node === 'string') return null

  for (const child of Object.values(node as Record<string, unknown>)) {
    if (typeof child === 'string' && child.startsWith('https://play-lh.googleusercontent.com/')) {
      return child
    }
    const nested = findIcon(child, depth + 1)
    if (nested !== null) return nested
  }
  return null
}

/**
 * A rating between 0 and 5 that is not an integer index.
 *
 * Entries are full of small integers, so requiring a fractional part is what
 * separates a real score from an array position. A genuinely integral rating
 * loses its score rather than inventing one from a stray 4.
 */
function findScore(node: unknown, depth = 0): number | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null

  for (const child of Object.values(node as Record<string, unknown>)) {
    if (typeof child === 'number' && child > 0 && child <= 5 && !Number.isInteger(child)) {
      return child
    }
    const nested = findScore(child, depth + 1)
    if (nested !== null) return nested
  }
  return null
}

function buildAppUrl(appId: string, lang: string, country: string): string {
  const qs = new URLSearchParams({ id: appId, hl: lang, gl: country })
  return `https://play.google.com/store/apps/details?${qs.toString()}`
}

/**
 * Every app entry in a payload, in document order.
 *
 * Deduplicated by package id: Play repeats the same app across clusters on a
 * category page, and a caller asking for "the apps on this page" wants each one
 * once.
 */
export function extractAppList(
  store: DataStore,
  opts: { lang: string; country: string; limit?: number },
): ListedApp[] {
  const limit = opts.limit ?? 200
  const seen = new Set<string>()
  const out: ListedApp[] = []

  const visit = (node: unknown, depth: number): void => {
    if (out.length >= limit || depth > 16) return
    if (node === null || typeof node !== 'object') return

    if (Array.isArray(node)) {
      const head = node[0]
      const appId = Array.isArray(head) && typeof head[0] === 'string' ? head[0] : null

      if (appId !== null && PACKAGE_ID.test(appId)) {
        if (!seen.has(appId)) {
          seen.add(appId)
          out.push({
            appId,
            title: str(node[3]),
            developer: str(node[14]) ?? str(node[4]),
            icon: findIcon(node[1]) ?? findIcon(node),
            score: findScore(node[4]) ?? findScore(node),
            scoreText: null,
            price: null,
            currency: null,
            free: null,
            url: buildAppUrl(appId, opts.lang, opts.country),
          })
        }
        // Do not descend into a matched entry: its children are its own fields,
        // not further apps.
        return
      }
    }

    for (const child of Object.values(node as Record<string, unknown>)) {
      visit(child, depth + 1)
    }
  }

  for (const block of store.values()) visit(block, 0)

  for (const app of out) {
    if (app.score !== null) app.scoreText = app.score.toFixed(1)
  }
  return out
}

export function parseAppListHtml(
  html: string,
  opts: { lang: string; country: string; limit?: number },
): ListedApp[] {
  return extractAppList(parseDataStore(html), opts)
}
