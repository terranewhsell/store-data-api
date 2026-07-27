CREATE TABLE "discovery_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"origin" text NOT NULL,
	"origin_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" text,
	"outcome" text NOT NULL,
	"duration_ms" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_candidates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" bigint NOT NULL,
	"candidate_source" text NOT NULL,
	"candidate_source_id" text NOT NULL,
	"candidate_title" text,
	"candidate_developer" text,
	"title_similarity" real,
	"developer_similarity" real,
	"confidence" real NOT NULL,
	"decision" text DEFAULT 'review' NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_candidates" ADD CONSTRAINT "match_candidates_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_queue_key" ON "discovery_queue" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "discovery_queue_claim_idx" ON "discovery_queue" USING btree ("status","priority","depth");--> statement-breakpoint
CREATE INDEX "discovery_queue_origin_idx" ON "discovery_queue" USING btree ("origin");--> statement-breakpoint
CREATE INDEX "ingest_events_recent_idx" ON "ingest_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ingest_events_source_outcome_idx" ON "ingest_events" USING btree ("source","outcome","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "match_candidates_key" ON "match_candidates" USING btree ("app_id","candidate_source_id");--> statement-breakpoint
CREATE INDEX "match_candidates_decision_idx" ON "match_candidates" USING btree ("decision","confidence");