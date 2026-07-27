/**
 * Database client.
 *
 * Two drivers, both real Postgres, same schema and same SQL:
 *
 *   postgres://...       postgres.js, for the deployed service
 *   pglite://./data/dir  PGlite, an embedded Postgres, for local work and tests
 *
 * This is not a compatibility shim over two different databases. PGlite is
 * Postgres compiled to WebAssembly, so `tsvector`, `jsonb`, generated columns and
 * the migrations all behave identically. It exists so the suite can run without a
 * server, not to allow a second dialect.
 */
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { PGlite } from '@electric-sql/pglite'
import { config } from '../config.ts'
import { logger } from '../lib/logger.ts'
import * as schema from './schema.ts'

/**
 * One type for both drivers.
 *
 * Typing this as a union of the two concrete database types makes every builder
 * method resolve against both signatures at once, which TypeScript collapses into
 * an unusable intersection. `PgDatabase` is the shared base of both, so callers
 * get one coherent API and the driver stays an implementation detail.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>

let db: Database | null = null
let pgClient: ReturnType<typeof postgres> | null = null
let pgliteClient: PGlite | null = null

export interface DbHandle {
  db: Database
  driver: 'postgres' | 'pglite'
}

export function getDb(): Database {
  if (db) return db

  if (config.driver === 'pglite') {
    pgliteClient = new PGlite(config.pgliteDir)
    db = drizzlePglite(pgliteClient, { schema }) as unknown as Database
    logger.info('database connected', { driver: 'pglite', dir: config.pgliteDir })
  } else {
    pgClient = postgres(config.DATABASE_URL, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      // Errors must surface; a silently swallowed connection problem looks
      // exactly like "there is no data".
      onnotice: (n) => logger.debug('postgres notice', { notice: n.message }),
    })
    db = drizzlePg(pgClient, { schema }) as unknown as Database
    logger.info('database connected', { driver: 'postgres' })
  }
  return db
}

export function getPgliteClient(): PGlite | null {
  return pgliteClient
}

export function getPostgresClient(): ReturnType<typeof postgres> | null {
  return pgClient
}

export async function closeDb(): Promise<void> {
  if (pgClient) {
    await pgClient.end({ timeout: 5 })
    pgClient = null
  }
  if (pgliteClient) {
    await pgliteClient.close()
    pgliteClient = null
  }
  db = null
}

export { schema }
