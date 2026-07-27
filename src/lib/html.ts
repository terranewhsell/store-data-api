/**
 * HTML entity decoding.
 *
 * The client reported this exact bug on the coupons project: `&#8217;` reaching
 * the consumer instead of `'`. Store descriptions are full of them, so every
 * text field is decoded once, on ingestion, before it is stored or served.
 *
 * Decoding is applied to text, never to `descriptionHTML`, whose entities are
 * part of the markup the consumer will render.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  laquo: '«',
  raquo: '»',
  iexcl: '¡',
  iquest: '¿',
  aacute: 'á',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ',
}

const ENTITY = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g

function decodeOnce(input: string): string {
  return input.replace(ENTITY, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      // Lone surrogates would produce invalid UTF-8 downstream.
      if (code >= 0xd800 && code <= 0xdfff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED[body]
    return named ?? whole
  })
}

/**
 * Decodes entities, including the double-encoded case (`&amp;#8217;`) that shows
 * up when a value has passed through two encoders. Bounded to three passes so a
 * pathological input cannot spin.
 */
export function decodeEntities(input: string): string {
  let out = input
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(out)
    if (next === out) break
    out = next
  }
  return out
}

/** Decodes when the value is a string, passes anything else through untouched. */
export function decodeText<T>(value: T): T {
  return (typeof value === 'string' ? decodeEntities(value) : value) as T
}

/** Strips tags and decodes, for building the search index text. */
export function toPlainText(input: string): string {
  return decodeEntities(
    input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
