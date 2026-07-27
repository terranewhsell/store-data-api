/**
 * The `AF_initDataCallback` payload.
 *
 * Google Play ships its page data as a series of inline scripts shaped like:
 *
 *   AF_initDataCallback({key: 'ds:5', hash: '...', data: [ ...deeply nested... ], sideChannel: {}});
 *
 * `data` is an array of arrays with no names anywhere. Everything is addressed by
 * position, which is why every Play parser in existence is a list of numeric
 * coordinates and why they all break together when Google reorders anything.
 *
 * This module does the mechanical half: find the blocks, parse them, expose them
 * by key. It deliberately does NOT know what any field means. Deciding that
 * `[1, 2, 0, 0]` is a title belongs in extract.ts, next to the fallbacks and the
 * cross-checks, so that the fragile knowledge lives in exactly one place.
 */

/** `AF_initDataCallback({key: 'ds:N', ..., data: <JSON>, sideChannel: ...});` */
const CALLBACK = /AF_initDataCallback\(([\s\S]*?)\);?\s*<\/script>/g

export type DataStore = Map<string, unknown>

/**
 * Pulls the value of a top-level `data:` property out of one callback argument.
 *
 * Not a regex: `data` holds arbitrarily nested arrays containing strings that can
 * themselves contain braces and brackets, so the extent has to be found by
 * counting depth while respecting string literals and escapes.
 */
function extractDataLiteral(source: string): string | null {
  const marker = /(?:^|[,{\s])data\s*:\s*/g
  const found = marker.exec(source)
  if (!found) return null

  const start = source.indexOf('[', found.index)
  if (start === -1) return null

  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false

  for (let i = start; i < source.length; i++) {
    const ch = source[i] as string

    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/** `key: 'ds:5'` */
function extractKey(source: string): string | null {
  const match = /key\s*:\s*'([^']+)'/.exec(source) ?? /key\s*:\s*"([^"]+)"/.exec(source)
  return match?.[1] ?? null
}

/**
 * Every data block on the page, by key.
 *
 * A block that fails to parse is skipped rather than throwing: the page carries
 * a dozen of them and only a couple matter, so one unparseable block about
 * something unrelated must not take the listing down with it.
 */
export function parseDataStore(html: string): DataStore {
  const store: DataStore = new Map()

  CALLBACK.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CALLBACK.exec(html)) !== null) {
    const body = match[1]
    if (!body) continue

    const key = extractKey(body)
    if (key === null) continue

    const literal = extractDataLiteral(body)
    if (literal === null) continue

    try {
      store.set(key, JSON.parse(literal))
    } catch {
      // Unparseable block: skip it. `store.size` lets the caller notice if the
      // page yielded nothing at all, which is the case that matters.
    }
  }

  return store
}

/**
 * Reads a value at a coordinate path, returning undefined rather than throwing
 * anywhere along the way.
 *
 * `path[0]` is the store key, the rest are array indices.
 */
export function at(store: DataStore, path: readonly (string | number)[]): unknown {
  if (path.length === 0) return undefined
  const [key, ...rest] = path
  let current: unknown = store.get(String(key))

  for (const step of rest) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[step as never]
  }
  return current ?? undefined
}

/**
 * Depth-first search for the first value satisfying a predicate.
 *
 * This is the fallback that makes drift survivable. When a coordinate stops
 * resolving because Google inserted a level somewhere, a field with a
 * recognisable shape — a URL on a known image host, a plausible install string,
 * an ISO timestamp — can still be found without knowing where it moved to.
 *
 * Bounded in both depth and nodes visited: these payloads are large, and an
 * unbounded walk over a megabyte of nested arrays on every request is its own
 * kind of outage.
 */
export function findFirst(
  root: unknown,
  predicate: (value: unknown) => boolean,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): unknown {
  const maxDepth = opts.maxDepth ?? 12
  const maxNodes = opts.maxNodes ?? 200_000
  let visited = 0

  const walk = (node: unknown, depth: number): unknown => {
    if (visited++ > maxNodes || depth > maxDepth) return undefined
    if (predicate(node)) return node
    if (node === null || typeof node !== 'object') return undefined

    for (const child of Object.values(node as Record<string, unknown>)) {
      const hit = walk(child, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  return walk(root, 0)
}

/** Every value satisfying a predicate, for fields that are genuinely lists. */
export function findAll(
  root: unknown,
  predicate: (value: unknown) => boolean,
  opts: { maxDepth?: number; maxNodes?: number; limit?: number } = {},
): unknown[] {
  const maxDepth = opts.maxDepth ?? 12
  const maxNodes = opts.maxNodes ?? 200_000
  const limit = opts.limit ?? 200
  const out: unknown[] = []
  let visited = 0

  const walk = (node: unknown, depth: number): void => {
    if (visited++ > maxNodes || depth > maxDepth || out.length >= limit) return
    if (predicate(node)) {
      out.push(node)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child, depth + 1)
    }
  }

  walk(root, 0)
  return out
}
