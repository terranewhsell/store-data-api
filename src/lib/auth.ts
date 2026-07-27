/**
 * Bearer authentication, ported from the coupons API.
 *
 * Two details from that implementation are load-bearing and are kept:
 *
 * 1. The header is read defensively. The PHP version read HTTP_AUTHORIZATION,
 *    REDIRECT_HTTP_AUTHORIZATION and getallheaders() because some hosts strip it.
 *    The underlying cause is the proxy, not PHP, so the same posture applies
 *    here: the canonical header plus one configurable fallback name.
 *
 * 2. The comparison is constant time (`hash_equals` there, `timingSafeEqual`
 *    here). Note that `timingSafeEqual` throws when the two buffers differ in
 *    length, and that exception alone would leak the token length. Both sides
 *    are therefore hashed to SHA-256 first, so the compared buffers are always
 *    32 bytes and the comparison is genuinely constant time.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { config } from '../config.ts'
import { noTokenConfigured, unauthorized } from './errors.ts'

const BEARER = /^Bearer\s+(.+)$/i

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function tokensMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected))
}

export function extractBearer(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null
  const match = BEARER.exec(headerValue.trim())
  if (!match || !match[1]) return null
  const token = match[1].trim()
  return token.length > 0 ? token : null
}

/**
 * Reads the token from `Authorization`, then from the configured fallback
 * header. Returns null when neither carries a usable Bearer value.
 */
export function readToken(
  getHeader: (name: string) => string | undefined,
  fallbackHeader = config.AUTH_FALLBACK_HEADER,
): string | null {
  const candidates = ['authorization', fallbackHeader.toLowerCase()]
  for (const name of candidates) {
    const token = extractBearer(getHeader(name))
    if (token) return token
  }
  return null
}

/**
 * Guards every /v1 route.
 *   no token configured on the server -> 503 store_no_token_configured
 *   no or wrong token from the caller -> 401 store_unauthorized
 */
export const requireBearer: MiddlewareHandler = async (c, next) => {
  const expected = config.API_BEARER_TOKEN
  if (!expected || expected.length === 0) throw noTokenConfigured()

  const presented = readToken((name) => c.req.header(name))
  if (!presented) throw unauthorized()
  if (!tokensMatch(presented, expected)) throw unauthorized()

  await next()
}
