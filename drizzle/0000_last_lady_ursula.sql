CREATE TABLE "app_locales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" bigint NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"country" text NOT NULL,
	"lang" text NOT NULL,
	"core" jsonb NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"title" text,
	"developer" text,
	"type" text NOT NULL,
	"genre_id" text,
	"score" real,
	"ratings" bigint,
	"price" real,
	"free" boolean,
	"min_installs" bigint,
	"updated_ms" bigint,
	"content_hash" text,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"genre_id" text,
	"developer_id" text,
	"ios_id" text,
	"ios_match_confidence" real,
	"ios_match_method" text,
	"is_popular" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"delisted_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"params" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_error_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_items" (
	"snapshot_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"source_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"collection" text NOT NULL,
	"category_id" text NOT NULL,
	"country" text NOT NULL,
	"lang" text NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" text,
	"country" text,
	"lang" text,
	"url" text,
	"http_status" integer,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_health" (
	"source" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"last_error" text,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_locales" ADD CONSTRAINT "app_locales_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_items" ADD CONSTRAINT "ranking_items_snapshot_id_ranking_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."ranking_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_locales_app_market_key" ON "app_locales" USING btree ("app_id","country","lang");--> statement-breakpoint
CREATE INDEX "app_locales_source_lookup_idx" ON "app_locales" USING btree ("source","source_id","country","lang");--> statement-breakpoint
CREATE INDEX "app_locales_market_idx" ON "app_locales" USING btree ("country","lang");--> statement-breakpoint
CREATE INDEX "app_locales_type_idx" ON "app_locales" USING btree ("type");--> statement-breakpoint
CREATE INDEX "app_locales_genre_idx" ON "app_locales" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "app_locales_score_idx" ON "app_locales" USING btree ("score");--> statement-breakpoint
CREATE INDEX "app_locales_expires_idx" ON "app_locales" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "app_locales_changed_idx" ON "app_locales" USING btree ("country","lang","last_changed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_source_source_id_key" ON "apps" USING btree ("source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_slug_key" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "apps_type_idx" ON "apps" USING btree ("type");--> statement-breakpoint
CREATE INDEX "apps_genre_idx" ON "apps" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "apps_developer_idx" ON "apps" USING btree ("developer_id");--> statement-breakpoint
CREATE INDEX "apps_ios_id_idx" ON "apps" USING btree ("ios_id");--> statement-breakpoint
CREATE INDEX "apps_status_idx" ON "apps" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_jobs_dedupe_key" ON "ingest_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ingest_jobs_claim_idx" ON "ingest_jobs" USING btree ("status","next_attempt_at","priority");--> statement-breakpoint
CREATE INDEX "ingest_jobs_source_idx" ON "ingest_jobs" USING btree ("source","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_items_pk" ON "ranking_items" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE INDEX "ranking_items_source_id_idx" ON "ranking_items" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_snapshot_key" ON "ranking_snapshots" USING btree ("source","collection","category_id","country","lang");--> statement-breakpoint
CREATE INDEX "ranking_snapshot_expires_idx" ON "ranking_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "raw_payloads_lookup_idx" ON "raw_payloads" USING btree ("source","kind","source_id","fetched_at");--> statement-breakpoint
CREATE INDEX "raw_payloads_fetched_idx" ON "raw_payloads" USING btree ("fetched_at");