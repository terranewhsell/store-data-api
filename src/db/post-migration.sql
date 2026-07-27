-- Statements that drizzle-kit cannot express, applied after the generated
-- migrations. Every one is idempotent: running the migration twice is a no-op.

-- Local full-text search index.
--
-- The 'simple' dictionary is deliberate. We serve many markets, so a single
-- language configuration would stem correctly for one of them and incorrectly for
-- all the others: 'english' turns the Spanish "traduccion" into a wrong stem.
-- 'simple' just lowercases and splits, which is the right behaviour when the
-- corpus is multilingual and the query language is unknown.
CREATE INDEX IF NOT EXISTS app_locales_search_idx
  ON app_locales USING GIN (to_tsvector('simple', search_text));

-- Cheap prefix/equality lookups on titles, used by the App Store cross-match.
CREATE INDEX IF NOT EXISTS app_locales_title_lower_idx
  ON app_locales (lower(title));

-- Ranking reads always ask for one snapshot ordered by position; this keeps that
-- a single index scan.
CREATE INDEX IF NOT EXISTS ranking_items_snapshot_position_idx
  ON ranking_items (snapshot_id, position);

-- Only pending work is ever claimed, so the claim index does not need to carry
-- finished rows.
CREATE INDEX IF NOT EXISTS ingest_jobs_pending_idx
  ON ingest_jobs (next_attempt_at, priority)
  WHERE status = 'pending';
