/**
 * Environment configuration. Nothing secret is ever hardcoded; everything comes
 * from the environment and is validated once, at boot, so a misconfigured deploy
 * fails loudly instead of silently serving wrong data.
 */
import { z } from 'zod'

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : v === '1' || v.toLowerCase() === 'true'))

const int = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().int())

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),

  /**
   * Postgres connection string. Two drivers are supported and both are real
   * Postgres, so the schema and the queries are identical:
   *   postgres://user:pass@host:port/db  -> postgres.js (server)
   *   pglite://./data/pgdata             -> PGlite (embedded, for local dev/tests)
   */
  DATABASE_URL: z.string().min(1).default('pglite://./data/pgdata'),

  /**
   * Bearer token required by every /v1 route. If it is absent the service does
   * not fall back to "open": it answers 503 store_no_token_configured, which
   * distinguishes "caller is unauthorized" from "service is misconfigured".
   */
  API_BEARER_TOKEN: z.string().optional(),

  /**
   * Some hosting stacks and reverse proxies strip the Authorization header.
   * The coupons API worked around this by reading three different places. Same
   * defensive posture here: one configurable fallback header name.
   */
  AUTH_FALLBACK_HEADER: z.string().default('x-authorization'),

  DEFAULT_COUNTRY: z.string().length(2).default('us'),
  DEFAULT_LANG: z.string().min(2).max(8).default('en'),

  MAX_PER_PAGE: int(200),
  DEFAULT_PER_PAGE: int(50),

  // Time-to-live per kind of data, in seconds. See README for the rationale.
  TTL_APP_POPULAR: int(24 * 60 * 60),
  TTL_APP_LONGTAIL: int(7 * 24 * 60 * 60),
  TTL_RANKING: int(6 * 60 * 60),
  TTL_REVIEWS: int(12 * 60 * 60),
  TTL_STEAM_CATALOG: int(24 * 60 * 60),

  // Pacing, per source, in milliseconds between requests.
  RATE_PLAY_MIN_INTERVAL_MS: int(2000),
  RATE_PLAY_MAX_INTERVAL_MS: int(3000),
  RATE_IOS_MIN_INTERVAL_MS: int(3000),
  RATE_IOS_MAX_INTERVAL_MS: int(3500),
  RATE_STEAM_MIN_INTERVAL_MS: int(1500),
  RATE_STEAM_MAX_INTERVAL_MS: int(2000),
  // SteamSpy documents one request per second outside its bulk endpoint.
  RATE_STEAMSPY_MIN_INTERVAL_MS: int(1100),
  RATE_STEAMSPY_MAX_INTERVAL_MS: int(1500),

  /**
   * Use SteamSpy to pre-fill Steam review counts in bulk.
   *
   * OFF by default. SteamSpy is a third-party service, and the client's position
   * is that this service should not depend on ones it does not control. With it
   * off, review counts come from Valve's own endpoint at one request per game,
   * which is slower and entirely ours.
   *
   * Turning it on trades that independence for roughly a thousandfold reduction
   * in requests, at about nine percent lower counts. Whoever turns it on should
   * be making that trade deliberately.
   */
  STEAMSPY_ENABLED: bool(false),
  STEAMSPY_PAGES: int(3),

  /**
   * Which Google Play parser to use.
   *
   *   own      our own parser (src/sources/play-parser). The default.
   *   library  google-play-scraper, kept as a fallback and as the yardstick the
   *            comparison runs against.
   *
   * The default moved once `bun run compare-parsers` reported 47 of 47 fields
   * identical on live listings, with zero differences. The only fields excluded
   * from that count are ones where ours is the more accurate of the two, each
   * documented in the comparison with its reason.
   */
  PLAY_PARSER: z.enum(['library', 'own']).default('own'),

  /**
   * Keep the page HTML alongside the parsed result.
   *
   * Until now Play stored the library's OUTPUT as its raw payload, which meant
   * reprocessing could only re-run our normalizer and could never fix a
   * parser-level mistake. The other two sources stored real API responses, so
   * the promise held for them and quietly did not for Play.
   */
  PLAY_STORE_HTML: bool(true),

  // Backoff on failure.
  BACKOFF_BASE_MS: int(5000),
  BACKOFF_MAX_MS: int(30 * 60 * 1000),
  MAX_ATTEMPTS: int(5),

  // Outbound HTTP.
  HTTP_TIMEOUT_MS: int(20000),
  HTTP_USER_AGENT: z
    .string()
    .default('store-data-api/1.0 (+contact: set HTTP_USER_AGENT in your environment)'),

  /**
   * Live fallback for /v1/search when the local index has nothing. Allowed for
   * App Store and Steam, which expose public APIs. Never for Google Play:
   * user-driven live requests to Play are the fastest way to get the IP banned.
   */
  LIVE_SEARCH_ENABLED: bool(true),
  LIVE_SEARCH_TIMEOUT_MS: int(1500),
  LIVE_SEARCH_RATE_LIMIT_PER_MIN: int(20),

  // Background worker.
  INGEST_WORKER_ENABLED: bool(false),
  INGEST_WORKER_CONCURRENCY: int(1),
  INGEST_POLL_INTERVAL_MS: int(1000),
})

export type Config = z.infer<typeof schema> & {
  isProduction: boolean
  driver: 'postgres' | 'pglite'
  pgliteDir: string
}

function build(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const cfg = parsed.data
  const isPglite = cfg.DATABASE_URL.startsWith('pglite://')
  return {
    ...cfg,
    isProduction: cfg.NODE_ENV === 'production',
    driver: isPglite ? 'pglite' : 'postgres',
    pgliteDir: isPglite ? cfg.DATABASE_URL.slice('pglite://'.length) : '',
  }
}

export const config = build(process.env as Record<string, string | undefined>)

/** Exposed for tests, which build a config from an explicit object. */
export const buildConfig = build
