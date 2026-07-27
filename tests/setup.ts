/**
 * Test environment.
 *
 * Runs before anything else imports src/config.ts, which validates the
 * environment once at load time.
 *
 * The suite uses PGlite, an embedded Postgres, against a throwaway directory. It
 * is the same Postgres the service runs on, so the schema, the migrations and the
 * full-text queries are all exercised for real rather than mocked.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'storedata-test-'))

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = `pglite://${dir}`
process.env.API_BEARER_TOKEN = 'test-token-do-not-use-in-production'
process.env.LOG_LEVEL = 'error'
process.env.DEFAULT_COUNTRY = 'us'
process.env.DEFAULT_LANG = 'en'
process.env.INGEST_WORKER_ENABLED = 'false'
// No test reaches the network. Anything that tries will time out fast and loudly
// rather than sitting there.
process.env.LIVE_SEARCH_ENABLED = 'false'
process.env.HTTP_TIMEOUT_MS = '2000'

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temp directory is not worth failing a test run over.
  }
})

export const TEST_TOKEN = process.env.API_BEARER_TOKEN
export const TEST_DB_DIR = dir
