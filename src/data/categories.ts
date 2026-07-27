/**
 * Canonical category list.
 *
 * The 55 entries in `categories.json` are served verbatim, in the exact order and
 * with the exact `id` / `slug` / `name` the client supplied. That file is the
 * contract: it is never regenerated, reordered or derived from a library.
 *
 * Two facts about that list matter operationally and are asserted by tests:
 *
 *  - 54 of the 55 ids match the `category` constants of `google-play-scraper`
 *    exactly, in the same order.
 *  - `GAME_WORLD` is the 55th and is NOT a Google Play category. It has no
 *    counterpart in the store taxonomy, so no ranking can be fetched for it.
 *    We still serve it (the client asked for the list verbatim), but the
 *    ingestion layer must never send it to Play, which would throw
 *    `Invalid category`.
 */
import raw from './categories.json' with { type: 'json' }

export interface Category {
  id: string
  slug: string
  name: string
}

export const CATEGORIES: readonly Category[] = Object.freeze(
  (raw as Category[]).map((c) => Object.freeze({ ...c })),
)

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]))
const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]))

/** Category ids that exist in our canonical list but not in Google Play's taxonomy. */
export const CATEGORIES_WITHOUT_PLAY_MAPPING: readonly string[] = Object.freeze(['GAME_WORLD'])

export function categoryById(id: string): Category | undefined {
  return BY_ID.get(id)
}

export function categoryBySlug(slug: string): Category | undefined {
  return BY_SLUG.get(slug)
}

/** Accepts either a canonical id (`GAME_ACTION`) or a slug (`game-action`). */
export function resolveCategory(value: string): Category | undefined {
  return BY_ID.get(value) ?? BY_SLUG.get(value.toLowerCase())
}

export function isIngestableOnPlay(id: string): boolean {
  return BY_ID.has(id) && !CATEGORIES_WITHOUT_PLAY_MAPPING.includes(id)
}

/** Category ids we are allowed to ask Google Play for. */
export const PLAY_INGESTABLE_CATEGORY_IDS: readonly string[] = Object.freeze(
  CATEGORIES.filter((c) => isIngestableOnPlay(c.id)).map((c) => c.id),
)
