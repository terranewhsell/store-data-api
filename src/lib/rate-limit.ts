/**
 * Per-caller rate limiting for the one route that can reach outside.
 *
 * `/v1/search` may fall back to a live query against App Store or Steam. That
 * makes it the only endpoint a third party could use to turn this service into a
 * megaphone pointed at Apple or Valve. It is limited from day one, not later.
 *
 * Sliding window, in memory. Single-process deployments are the common case here;
 * if this ever runs behind more than one instance the same interface can be
 * backed by Postgres or Redis without touching callers.
 */
export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private lastSweep = 0

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
  }

  check(key: string, now = Date.now()): RateLimitResult {
    this.sweep(now)
    const cutoff = now - this.windowMs
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff)

    if (timestamps.length >= this.limit) {
      const oldest = timestamps[0] as number
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      }
    }

    timestamps.push(now)
    this.hits.set(key, timestamps)
    return { allowed: true, remaining: this.limit - timestamps.length, retryAfterSeconds: 0 }
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    const cutoff = now - this.windowMs
    for (const [key, timestamps] of this.hits) {
      const kept = timestamps.filter((t) => t > cutoff)
      if (kept.length === 0) this.hits.delete(key)
      else this.hits.set(key, kept)
    }
  }

  reset(): void {
    this.hits.clear()
  }
}

/**
 * Identity for limiting: the presented token when there is one, otherwise the
 * client IP. Token first, because one token behind a NAT should not be able to
 * hide behind a shared address.
 */
export function callerKey(headers: {
  authorization?: string | undefined
  forwardedFor?: string | undefined
  remoteAddress?: string | undefined
}): string {
  if (headers.authorization) {
    // The token itself never enters a map key; a short digest is enough to
    // distinguish callers.
    let hash = 0
    for (let i = 0; i < headers.authorization.length; i++) {
      hash = (hash * 31 + headers.authorization.charCodeAt(i)) | 0
    }
    return `t:${hash}`
  }
  const forwarded = headers.forwardedFor?.split(',')[0]?.trim()
  return `ip:${forwarded || headers.remoteAddress || 'unknown'}`
}
