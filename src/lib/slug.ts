/**
 * Permanent slugs.
 *
 * A slug is generated once, from the first title we ever see for an app, and then
 * frozen. It is never recomputed from a later title. An app renamed in the store
 * keeps its URL, because a URL that moves takes its search ranking with it.
 *
 * Collisions are resolved deterministically, from the app's native id, so the
 * same app always produces the same slug no matter when or in what order it is
 * ingested. Nothing here depends on a counter, a timestamp or insertion order.
 */
import { createHash } from 'node:crypto'

const MAX_BASE_LENGTH = 80

/** Latin transliteration for the accented characters store titles actually use. */
const TRANSLITERATE: Record<string, string> = {
  æ: 'ae',
  ø: 'o',
  å: 'a',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ŋ: 'n',
  œ: 'oe',
  '&': ' and ',
  '+': ' plus ',
  '@': ' at ',
}

export function slugify(input: string): string {
  const lowered = input.toLowerCase()

  let mapped = ''
  for (const ch of lowered) mapped += TRANSLITERATE[ch] ?? ch

  const base = mapped
    // Split accents from their base letters, then drop the accents.
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Anything that is not a latin letter or digit becomes a separator. Scripts
    // without a latin form (Japanese, Korean, Arabic) collapse to nothing here,
    // which is why `appSlug` falls back to the id when the result is empty.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/g, '')

  return base
}

function shortHash(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 7)
}

export interface SlugInput {
  title: string
  source: string
  sourceId: string
}

/**
 * The preferred slug for an app. Callers must persist the result and treat it as
 * immutable from then on.
 */
export function appSlug({ title, source, sourceId }: SlugInput): string {
  const base = slugify(title)
  if (base.length >= 2) return base
  // Titles that transliterate to nothing (fully non-latin scripts) still need a
  // readable, stable identifier: fall back to the native id.
  const fromId = slugify(sourceId)
  if (fromId.length >= 2) return `${source}-${fromId}`.slice(0, MAX_BASE_LENGTH)
  return `${source}-${shortHash(`${source}:${sourceId}`)}`
}

/**
 * Deterministic disambiguation when the preferred slug is already taken by a
 * different app. Always the same suffix for the same app.
 */
export function disambiguateSlug(preferred: string, source: string, sourceId: string): string {
  const suffix = shortHash(`${source}:${sourceId}`)
  const room = MAX_BASE_LENGTH - suffix.length - 1
  const trimmed = preferred.slice(0, Math.max(1, room)).replace(/-+$/g, '')
  return `${trimmed}-${suffix}`
}
