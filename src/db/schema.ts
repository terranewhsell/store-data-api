/**
 * Database schema.
 *
 * The shape follows one decision: the IDENTITY of an app and its APPEARANCE in a
 * given market are different things. Title, description, price, install count and
 * rank all change with country and language, so they live in `app_locales`, keyed
 * by (app, country, lang). `apps` holds only what is true everywhere.
 *
 * Getting this wrong is the mistake that cannot be fixed later without a
 * migration and a broken contract, which is why it is written before any route.
 *
 * `raw_payloads` keeps the untouched source response next to every normalized
 * row. When a store changes its format, and it will, being able to reprocess
 * without re-fetching is the difference between an afternoon and a week.
 */
import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/** App identity. One row per (source, native id). */
export const apps = pgTable(
  'apps',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 'play' | 'ios' | 'steam' */
    source: text('source').notNull(),
    /** Native id in its own store: package name, iTunes id, Steam appid. */
    sourceId: text('source_id').notNull(),
    /**
     * Permanent, human-readable URL segment. Generated ONCE, on first sight, and
     * never recomputed: if an app is renamed in the store its page URL must not
     * move, or whatever ranking that page had is thrown away. This column is
     * write-once by contract, enforced by the repository layer.
     */
    slug: text('slug').notNull(),

    /** 'app' | 'game' */
    type: text('type').notNull(),
    genreId: text('genre_id'),
    developerId: text('developer_id'),

    /** Cross-link to the App Store listing, with the confidence of the match. */
    iosId: text('ios_id'),
    iosMatchConfidence: real('ios_match_confidence'),
    iosMatchMethod: text('ios_match_method'),

    /** Set when the app has appeared in any ranking; drives the shorter TTL. */
    isPopular: boolean('is_popular').notNull().default(false),

    /**
     * 'active' | 'delisted' | 'unknown'.
     * Apps that vanish from the store are marked, never deleted. A row that
     * disappears leaves an empty page behind it; a flagged row lets the front end
     * decide whether to show a notice, redirect, or drop the page deliberately.
     */
    status: text('status').notNull().default('active'),
    delistedAt: timestamp('delisted_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('apps_source_source_id_key').on(t.source, t.sourceId),
    uniqueIndex('apps_slug_key').on(t.slug),
    index('apps_type_idx').on(t.type),
    index('apps_genre_idx').on(t.genreId),
    index('apps_developer_idx').on(t.developerId),
    index('apps_ios_id_idx').on(t.iosId),
    index('apps_status_idx').on(t.status),
  ],
)

/**
 * The app as it appears in one market.
 *
 * `core` is the canonical flat object the client specified, stored verbatim so
 * serving is a read and not a rebuild. The scalar columns beside it are
 * denormalized copies used for filtering and ordering; they are derived from
 * `core` on write and never edited independently.
 */
export const appLocales = pgTable(
  'app_locales',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: bigint('app_id', { mode: 'number' })
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    country: text('country').notNull(),
    lang: text('lang').notNull(),

    core: jsonb('core').notNull(),
    /**
     * Cross-store equivalents. Stored rather than recomputed on read for the
     * same reason `core` is: serving should be a read, not a rebuild.
     * Ranking placements are the exception and are joined in at read time, since
     * they belong to the chart and change on its schedule, not the listing's.
     */
    common: jsonb('common').notNull().default(sql`'{}'::jsonb`),
    extra: jsonb('extra').notNull().default(sql`'{}'::jsonb`),
    coverage: jsonb('coverage').notNull().default(sql`'{}'::jsonb`),

    /** Title + summary + plain-text description, used by the local search index. */
    searchText: text('search_text').notNull().default(''),

    title: text('title'),
    developer: text('developer'),
    type: text('type').notNull(),
    genreId: text('genre_id'),
    score: real('score'),
    ratings: bigint('ratings', { mode: 'number' }),
    price: real('price'),
    free: boolean('free'),
    minInstalls: bigint('min_installs', { mode: 'number' }),
    /** The store's own `updated` value, epoch milliseconds. */
    updatedMs: bigint('updated_ms', { mode: 'number' }),

    /**
     * Digest of the served content. Refreshing an app usually returns exactly
     * what we already had; `fetched_at` moves every time, `last_changed_at` only
     * when the content actually differs.
     *
     * That distinction is the whole point of the incremental export: a static
     * site build that keys off `fetched_at` rebuilds every page on every refresh,
     * which for tens of thousands of pages makes each deploy unusable.
     */
    contentHash: text('content_hash'),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('app_locales_app_market_key').on(t.appId, t.country, t.lang),
    index('app_locales_source_lookup_idx').on(t.source, t.sourceId, t.country, t.lang),
    index('app_locales_market_idx').on(t.country, t.lang),
    index('app_locales_type_idx').on(t.type),
    index('app_locales_genre_idx').on(t.genreId),
    index('app_locales_score_idx').on(t.score),
    index('app_locales_expires_idx').on(t.expiresAt),
    // Drives `/v1/export/apps?since=`: keyset walk over what actually changed.
    index('app_locales_changed_idx').on(t.country, t.lang, t.lastChangedAt, t.id),
  ],
)

/**
 * One current ranking per (source, collection, category, market).
 *
 * History is deliberately not kept here: nobody asked for rank tracking, and
 * `raw_payloads` retains every list response, so a history table can be built
 * later from data we already have instead of being carried now for nothing.
 */
export const rankingSnapshots = pgTable(
  'ranking_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    /** 'TOP_FREE' | 'TOP_PAID' | 'GROSSING' */
    collection: text('collection').notNull(),
    categoryId: text('category_id').notNull(),
    country: text('country').notNull(),
    lang: text('lang').notNull(),
    itemCount: integer('item_count').notNull().default(0),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('ranking_snapshot_key').on(
      t.source,
      t.collection,
      t.categoryId,
      t.country,
      t.lang,
    ),
    index('ranking_snapshot_expires_idx').on(t.expiresAt),
  ],
)

export const rankingItems = pgTable(
  'ranking_items',
  {
    snapshotId: bigint('snapshot_id', { mode: 'number' })
      .notNull()
      .references(() => rankingSnapshots.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    sourceId: text('source_id').notNull(),
  },
  (t) => [
    uniqueIndex('ranking_items_pk').on(t.snapshotId, t.position),
    index('ranking_items_source_id_idx').on(t.sourceId),
  ],
)

/** Untouched source responses. The safety net for every future format change. */
export const rawPayloads = pgTable(
  'raw_payloads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    /** 'app' | 'list' | 'search' | 'reviews' | 'catalog' */
    kind: text('kind').notNull(),
    sourceId: text('source_id'),
    country: text('country'),
    lang: text('lang'),
    url: text('url'),
    httpStatus: integer('http_status'),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('raw_payloads_lookup_idx').on(t.source, t.kind, t.sourceId, t.fetchedAt),
    index('raw_payloads_fetched_idx').on(t.fetchedAt),
  ],
)

/** Ingest queue. Paced, retried with growing backoff, and never silent. */
export const ingestJobs = pgTable(
  'ingest_jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 'app' | 'ranking' | 'search' | 'catalog' | 'match_ios' */
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    params: jsonb('params').notNull(),
    /** Stable key so re-enqueuing the same work updates instead of piling up. */
    dedupeKey: text('dedupe_key').notNull(),
    priority: integer('priority').notNull().default(100),
    /** 'pending' | 'running' | 'done' | 'failed' | 'blocked' */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    lastErrorKind: text('last_error_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ingest_jobs_dedupe_key').on(t.dedupeKey),
    index('ingest_jobs_claim_idx').on(t.status, t.nextAttemptAt, t.priority),
    index('ingest_jobs_source_idx').on(t.source, t.status),
  ],
)

/**
 * Discovery queue.
 *
 * Google Play cannot be enumerated: there is no "give me every app". So the
 * catalogue is grown, and where each id came from matters as much as the id.
 *
 * Discovery and download are deliberately separate tables. Discovering an id is
 * cheap and safe; downloading its listing is expensive and can get us blocked.
 * Collapsing the two would mean a burst of discoveries becoming a burst of
 * requests, which is precisely how the IP gets banned.
 *
 * Deduplication happens here, on insert, before anything is ever enqueued.
 */
export const discoveryQueue = pgTable(
  'discovery_queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    /** 'ranking' | 'similar' | 'developer' | 'search' | 'catalog' | 'manual' */
    origin: text('origin').notNull(),
    originDetail: jsonb('origin_detail').notNull().default(sql`'{}'::jsonb`),
    /** Lower runs first: rankings before similars before long tail. */
    priority: integer('priority').notNull().default(100),
    /** Breadth-first depth from the seed, so traversal can be bounded. */
    depth: integer('depth').notNull().default(0),
    /** 'pending' | 'queued' | 'ingested' | 'skipped' */
    status: text('status').notNull().default('pending'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('discovery_queue_key').on(t.source, t.sourceId),
    index('discovery_queue_claim_idx').on(t.status, t.priority, t.depth),
    index('discovery_queue_origin_idx').on(t.origin),
  ],
)

/**
 * Cross-store match candidates for `iosId`.
 *
 * There is no identifier shared between Google Play and the App Store, so the
 * link has to be inferred from name and developer. A wrong link is worse than no
 * link: it sends a user to a different product. So anything short of confident
 * is stored here for review and the contract field stays null.
 *
 * Keeping the candidates means a later review does not have to redo the search.
 */
export const matchCandidates = pgTable(
  'match_candidates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: bigint('app_id', { mode: 'number' })
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    candidateSource: text('candidate_source').notNull(),
    candidateSourceId: text('candidate_source_id').notNull(),
    candidateTitle: text('candidate_title'),
    candidateDeveloper: text('candidate_developer'),
    titleSimilarity: real('title_similarity'),
    developerSimilarity: real('developer_similarity'),
    confidence: real('confidence').notNull(),
    /** 'accepted' | 'rejected' | 'review' */
    decision: text('decision').notNull().default('review'),
    method: text('method').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('match_candidates_key').on(t.appId, t.candidateSourceId),
    index('match_candidates_decision_idx').on(t.decision, t.confidence),
  ],
)

/**
 * Ingest event log.
 *
 * An ingest process that quietly stops is the most expensive failure there is,
 * because nobody notices until the data is already stale. On the coupons project
 * a queue crawled for hours with nothing to show it. This table is what
 * `/v1/status` reads to answer "is it actually moving, and what is failing".
 */
export const ingestEvents = pgTable(
  'ingest_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    kind: text('kind').notNull(),
    sourceId: text('source_id'),
    /** 'ok' | 'incomplete' | 'not_found' | 'blocked' | 'rate_limited' | 'malformed' | 'timeout' | 'unavailable' */
    outcome: text('outcome').notNull(),
    durationMs: integer('duration_ms'),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ingest_events_recent_idx').on(t.createdAt),
    index('ingest_events_source_outcome_idx').on(t.source, t.outcome, t.createdAt),
  ],
)

/** Persisted breaker state, so a restart does not forget it was being blocked. */
export const sourceHealth = pgTable('source_health', {
  source: text('source').primaryKey(),
  /** 'ok' | 'throttled' | 'blocked' */
  state: text('state').notNull().default('ok'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }),
  lastError: text('last_error'),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const appsRelations = relations(apps, ({ many }) => ({
  locales: many(appLocales),
}))

export const appLocalesRelations = relations(appLocales, ({ one }) => ({
  app: one(apps, { fields: [appLocales.appId], references: [apps.id] }),
}))

export const rankingSnapshotRelations = relations(rankingSnapshots, ({ many }) => ({
  items: many(rankingItems),
}))

export const rankingItemsRelations = relations(rankingItems, ({ one }) => ({
  snapshot: one(rankingSnapshots, {
    fields: [rankingItems.snapshotId],
    references: [rankingSnapshots.id],
  }),
}))

export type AppRow = typeof apps.$inferSelect
export type AppInsert = typeof apps.$inferInsert
export type AppLocaleRow = typeof appLocales.$inferSelect
export type AppLocaleInsert = typeof appLocales.$inferInsert
export type IngestJobRow = typeof ingestJobs.$inferSelect
