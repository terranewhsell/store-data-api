/**
 * Error shape.
 *
 * The client's team already integrates against the coupons API, whose errors are
 * WP_Error serialisations:
 *
 *   {"code":"ce_unauthorized","message":"...","data":{"status":401}}
 *
 * We replicate that FORM exactly: `code`, `message`, `data.status`. We do not
 * replicate the text (the coupons plugin answers in Spanish because WordPress
 * translates it; this service answers in English) nor the `ce_` prefix, which
 * belongs to the coupon engine.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export interface ApiErrorBody {
  code: string
  message: string
  data: { status: number; [k: string]: unknown }
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly extra: Record<string, unknown>

  constructor(code: string, message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.extra = extra
  }

  toBody(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      data: { status: this.status, ...this.extra },
    }
  }

  get httpStatus(): ContentfulStatusCode {
    return this.status as ContentfulStatusCode
  }
}

/** 401 - caller did not present a usable Bearer token. */
export const unauthorized = () =>
  new ApiError(
    'store_unauthorized',
    'Unauthorized: Authorization: Bearer <token> is required.',
    401,
  )

/**
 * 503 - the server itself has no token configured. Deliberately NOT a 401:
 * "you are not authorized" and "this service is misconfigured" are different
 * problems and the caller must be able to tell them apart. Mirrors
 * ce_no_token_configured in the coupons API.
 */
export const noTokenConfigured = () =>
  new ApiError(
    'store_no_token_configured',
    'Service unavailable: no API token is configured on the server.',
    503,
  )

export const badRequest = (message: string, extra: Record<string, unknown> = {}) =>
  new ApiError('store_bad_request', message, 400, extra)

export const notFound = (message = 'Resource not found.') =>
  new ApiError('store_not_found', message, 404)

export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError('store_rate_limited', 'Too many requests. Slow down.', 429, {
    retry_after: retryAfterSeconds,
  })

export const upstreamUnavailable = (message: string) =>
  new ApiError('store_upstream_unavailable', message, 503)

export const internal = (message = 'Internal server error.') =>
  new ApiError('store_internal_error', message, 500)
