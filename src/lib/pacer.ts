/**
 * Outbound pacing and circuit breaking, per source.
 *
 * The brief is explicit about why this exists: on the coupons project the hosting
 * IP was blocked twice by request bursts. So this is designed so it does not
 * happen, not so we can react once it has.
 *
 * Three guarantees:
 *  - Requests to a given source are serialised and separated by a randomised
 *    interval. Fixed intervals are themselves a fingerprint; the jitter is not
 *    decoration.
 *  - A blocked or malformed answer opens a circuit breaker for that source, with
 *    exponential backoff. While it is open nothing is sent at all.
 *  - The breaker state is readable, so the API can report degraded sources
 *    instead of pretending everything is fine.
 */
import { config } from '../config.ts'
import { logger } from './logger.ts'
import type { SourceError, SourceName } from './source-errors.ts'

export interface PacerState {
  source: SourceName
  state: 'ok' | 'throttled' | 'blocked'
  consecutiveFailures: number
  blockedUntil: number | null
  lastError: string | null
  requestsSent: number
  lastRequestAt: number | null
}

export class BreakerOpenError extends Error {
  readonly source: SourceName
  readonly retryAfterMs: number
  constructor(source: SourceName, retryAfterMs: number, lastError: string | null) {
    super(
      `Source ${source} is circuit-broken for another ${Math.ceil(retryAfterMs / 1000)}s` +
        (lastError ? `: ${lastError}` : '.'),
    )
    this.name = 'BreakerOpenError'
    this.source = source
    this.retryAfterMs = retryAfterMs
  }
}

export class Pacer {
  readonly source: SourceName
  private readonly minIntervalMs: number
  private readonly maxIntervalMs: number
  private chain: Promise<unknown> = Promise.resolve()
  private lastStart = 0
  private consecutiveFailures = 0
  private blockedUntil: number | null = null
  private lastError: string | null = null
  private requestsSent = 0

  constructor(source: SourceName, minIntervalMs: number, maxIntervalMs: number) {
    this.source = source
    this.minIntervalMs = minIntervalMs
    this.maxIntervalMs = Math.max(maxIntervalMs, minIntervalMs)
  }

  private nextInterval(): number {
    const span = this.maxIntervalMs - this.minIntervalMs
    return this.minIntervalMs + (span > 0 ? Math.floor(Math.random() * span) : 0)
  }

  get state(): PacerState {
    const now = Date.now()
    const blocked = this.blockedUntil !== null && this.blockedUntil > now
    return {
      source: this.source,
      state: blocked ? 'blocked' : this.consecutiveFailures > 0 ? 'throttled' : 'ok',
      consecutiveFailures: this.consecutiveFailures,
      blockedUntil: blocked ? this.blockedUntil : null,
      lastError: this.lastError,
      requestsSent: this.requestsSent,
      lastRequestAt: this.lastStart || null,
    }
  }

  get isOpen(): boolean {
    return this.blockedUntil !== null && this.blockedUntil > Date.now()
  }

  /** Time to wait before the breaker closes, 0 when it is already closed. */
  get retryAfterMs(): number {
    if (this.blockedUntil === null) return 0
    return Math.max(0, this.blockedUntil - Date.now())
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.blockedUntil = null
    this.lastError = null
  }

  recordFailure(error: SourceError): void {
    this.consecutiveFailures += 1
    this.lastError = `${error.kind}: ${error.message}`
    if (!error.trippsBreaker) return

    const backoff = Math.min(
      config.BACKOFF_MAX_MS,
      config.BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1),
    )
    this.blockedUntil = Date.now() + backoff
    logger.warn('source circuit breaker opened', {
      source: this.source,
      kind: error.kind,
      consecutive_failures: this.consecutiveFailures,
      backoff_ms: backoff,
      error: error.message,
    })
  }

  /**
   * Runs `fn` under this source's pacing. Calls are queued, so two concurrent
   * callers never produce two simultaneous outbound requests.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      if (this.isOpen) {
        throw new BreakerOpenError(this.source, this.retryAfterMs, this.lastError)
      }
      const wait = this.lastStart + this.nextInterval() - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastStart = Date.now()
      this.requestsSent += 1
      return fn()
    })
    // Keep the chain alive regardless of outcome, otherwise one rejection
    // permanently poisons every later call.
    this.chain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const pacers: Record<SourceName, Pacer> = {
  play: new Pacer('play', config.RATE_PLAY_MIN_INTERVAL_MS, config.RATE_PLAY_MAX_INTERVAL_MS),
  ios: new Pacer('ios', config.RATE_IOS_MIN_INTERVAL_MS, config.RATE_IOS_MAX_INTERVAL_MS),
  steam: new Pacer('steam', config.RATE_STEAM_MIN_INTERVAL_MS, config.RATE_STEAM_MAX_INTERVAL_MS),
}

export function allPacerStates(): PacerState[] {
  return Object.values(pacers).map((p) => p.state)
}
