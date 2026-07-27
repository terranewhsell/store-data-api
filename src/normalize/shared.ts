/**
 * Helpers shared by the three normalizers.
 *
 * The rule they all enforce: absent means null, never a stand-in. A price of 0
 * for an app whose price we could not read is worse than no price at all,
 * because it will be believed.
 */
import { decodeEntities, toPlainText } from '../lib/html.ts'
import type { AppType, CanonicalApp, CategoryRef } from './contract.ts'

/** `undefined`, empty string and NaN all collapse to null. */
export function orNull<T>(value: T | undefined | null): T | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

export function str(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.trim() === '' ? null : decodeEntities(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** Kept as-is: entities inside markup are part of the markup. */
export function html(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function int(value: unknown): number | null {
  const n = num(value)
  return n === null ? null : Math.trunc(n)
}

export function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return null
}

export function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}

/**
 * app or game.
 *
 * Google Play's own signal is the genre id prefix. FAMILY is the exception the
 * brief calls out: it is a shelf, not a genre, and holds both games and apps, so
 * the sub-categories decide.
 */
export function deriveTypeFromPlay(
  genreId: string | null,
  categories: CategoryRef[] = [],
): AppType {
  if (genreId && genreId.startsWith('GAME')) return 'game'
  if (genreId === 'FAMILY') {
    const hasGameCategory = categories.some((c) => (c.id ?? '').startsWith('GAME'))
    return hasGameCategory ? 'game' : 'app'
  }
  const anyGame = categories.some((c) => (c.id ?? '').startsWith('GAME'))
  return anyGame ? 'game' : 'app'
}

/** Steam's own `type` field. Software and tools are apps; everything else plays. */
export function deriveTypeFromSteam(steamType: string | null): AppType {
  const t = (steamType ?? '').toLowerCase()
  if (t === 'software' || t === 'application' || t === 'tool' || t === 'config') return 'app'
  return 'game'
}

/**
 * The text the local search index is built from. Description included, because a
 * search that only matches titles is not a search.
 */
export function buildSearchText(core: CanonicalApp): string {
  const parts = [
    core.title,
    core.developer,
    core.summary,
    core.genre,
    core.description ? toPlainText(core.description).slice(0, 4000) : null,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  return parts.join(' \n ').slice(0, 20_000)
}

/** Stable digest of the served content, used to tell a refresh from a change. */
export function contentDigest(core: CanonicalApp): string {
  // Field order is fixed by CANONICAL_FIELDS, so the digest is reproducible.
  return Bun.hash(JSON.stringify(core)).toString(16)
}

/** Plain text from a possibly-HTML source field, null when there is nothing. */
export function toPlainTextSafe(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = toPlainText(value)
  return text.length > 0 ? text : null
}

export function scoreToText(score: number | null): string | null {
  if (score === null) return null
  return score.toFixed(1)
}

/** Epoch milliseconds from whatever shape the source used. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs milliseconds: anything below this threshold is not a plausible
    // millisecond timestamp for a store listing.
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
