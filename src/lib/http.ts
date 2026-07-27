/**
 * Outbound HTTP with block detection.
 *
 * Every response is classified before anyone gets to look at its contents:
 *   403 / consent or captcha markup -> blocked
 *   429                             -> rate_limited
 *   404                             -> not_found
 *   5xx / network / abort           -> unavailable or timeout
 *   200 but not the expected shape  -> malformed
 *
 * The last case is the one that actually saves the database. Stores change their
 * payloads without warning; when that happens we want a loud, recorded failure,
 * not a row full of nulls that looks like a real app with no data.
 */
import { z } from 'zod'
import { config } from '../config.ts'
import { SourceError, type SourceName } from './source-errors.ts'

export interface FetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Treat a 404 as a legitimate "does not exist" rather than a failure. */
  allowNotFound?: boolean
}

const CONSENT_MARKERS = [
  'consent.google.com',
  'Our systems have detected unusual traffic',
  'g-recaptcha',
  'captcha-form',
  'unusual traffic from your computer network',
]

export async function fetchText(
  source: SourceName,
  url: string,
  opts: FetchOptions = {},
): Promise<string> {
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? config.HTTP_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'user-agent': config.HTTP_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en',
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      signal: controller.signal,
      redirect: 'follow',
    })
  } catch (cause) {
    clearTimeout(timer)
    const aborted = cause instanceof Error && cause.name === 'AbortError'
    throw new SourceError(
      source,
      aborted ? 'timeout' : 'unavailable',
      aborted ? `Request to ${source} timed out after ${timeoutMs}ms.` : `Network failure calling ${source}.`,
      { detail: { url }, cause },
    )
  } finally {
    clearTimeout(timer)
  }

  const status = response.status
  const text = await response.text().catch(() => '')

  if (status === 429) {
    throw new SourceError(source, 'rate_limited', `${source} returned 429.`, {
      status,
      detail: { url, retry_after: response.headers.get('retry-after') },
    })
  }
  if (status === 403 || status === 401) {
    throw new SourceError(source, 'blocked', `${source} refused the request with ${status}.`, {
      status,
      detail: { url },
    })
  }
  if (status === 404 || status === 410) {
    throw new SourceError(source, 'not_found', `${source} has no such resource.`, {
      status,
      detail: { url },
    })
  }
  if (status >= 500) {
    throw new SourceError(source, 'unavailable', `${source} returned ${status}.`, {
      status,
      detail: { url },
    })
  }
  if (status < 200 || status >= 300) {
    throw new SourceError(source, 'malformed', `${source} returned unexpected status ${status}.`, {
      status,
      detail: { url },
    })
  }

  // 200 with a consent wall or captcha is a block wearing a success code.
  const probe = text.slice(0, 4000)
  for (const marker of CONSENT_MARKERS) {
    if (probe.includes(marker)) {
      throw new SourceError(source, 'blocked', `${source} served a consent or captcha wall.`, {
        status,
        detail: { url, marker },
      })
    }
  }

  return text
}

/**
 * Fetches and validates against a schema in one step. A body that does not
 * validate is `malformed`, never silently coerced.
 */
export async function fetchJson<T>(
  source: SourceName,
  url: string,
  schema: z.ZodType<T>,
  opts: FetchOptions = {},
): Promise<T> {
  const text = await fetchText(source, url, opts)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new SourceError(source, 'malformed', `${source} returned a body that is not JSON.`, {
      detail: { url, body_preview: text.slice(0, 300) },
      cause,
    })
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new SourceError(
      source,
      'malformed',
      `${source} returned JSON that does not match the expected shape. Refusing to store it.`,
      {
        detail: {
          url,
          issues: result.error.issues.slice(0, 8).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      },
    )
  }
  return result.data
}

/** Raw JSON, for storing the untouched payload alongside the normalized one. */
export async function fetchRawJson(
  source: SourceName,
  url: string,
  opts: FetchOptions = {},
): Promise<unknown> {
  const text = await fetchText(source, url, opts)
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new SourceError(source, 'malformed', `${source} returned a body that is not JSON.`, {
      detail: { url, body_preview: text.slice(0, 300) },
      cause,
    })
  }
}
