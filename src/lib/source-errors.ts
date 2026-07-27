/**
 * Errors raised by the source layer.
 *
 * The important one is `malformed`. When a source answers with something that
 * does not match the shape we expect, the wrong reaction is to shrug and store
 * whatever parsed. A silently empty field is worse than a loud failure: it looks
 * like real data forever. So an unexpected shape is an error, the job is marked,
 * and nothing is written to the canonical tables.
 */
/**
 * Internal provider identity. Wider than the contract's `Source`, which stays
 * play | ios | steam: SteamSpy is an auxiliary provider FOR the steam source,
 * not a fourth store. Keeping the two types separate is what stops an
 * implementation detail from leaking into the published contract.
 */
export type SourceName = 'play' | 'ios' | 'steam' | 'steamspy'

export type SourceErrorKind =
  | 'blocked' // 403 / captcha / consent wall: we are being refused
  | 'rate_limited' // 429 or explicit throttle
  | 'not_found' // the app genuinely does not exist in this market
  | 'unavailable' // 5xx or network failure
  | 'timeout'
  | 'malformed' // 200 OK with a body that does not match the expected shape

export class SourceError extends Error {
  readonly source: SourceName
  readonly kind: SourceErrorKind
  readonly status: number | undefined
  readonly detail: Record<string, unknown>

  constructor(
    source: SourceName,
    kind: SourceErrorKind,
    message: string,
    opts: { status?: number; detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'SourceError'
    this.source = source
    this.kind = kind
    this.status = opts.status
    this.detail = opts.detail ?? {}
  }

  /** Whether retrying the same request later could plausibly succeed. */
  get retryable(): boolean {
    return this.kind !== 'not_found' && this.kind !== 'malformed'
  }

  /** Whether this should trip the circuit breaker for the whole source. */
  get trippsBreaker(): boolean {
    return this.kind === 'blocked' || this.kind === 'rate_limited' || this.kind === 'malformed'
  }
}

export function isSourceError(e: unknown): e is SourceError {
  return e instanceof SourceError
}
