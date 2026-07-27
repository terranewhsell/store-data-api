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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { PGlite } from '@electric-sql/pglite'
import { config } from '../config.ts'
import { logger } from '../lib/logger.ts'
import * as schema from './schema.ts'

/**
 * The lock lives BESIDE the data directory, never inside it.
 *
 * PGlite decides whether a directory is an initialised data directory by looking
 * at its contents. A stray lock file inside makes it read a half-initialised
 * database and fail with `CREATE SCHEMA` errors, which is the same misleading
 * symptom this whole change exists to remove.
 */
function lockPathFor(dir: string): string {
  return `${dir.replace(/[\/]+$/, '')}.lock`
}

/**
 * Single-writer lock for PGlite.
 *
 * PGlite is an embedded, single-process Postgres. Two processes opening the same
 * directory do not share it: each loads its own copy and flushes over the other.
 * Measured behaviour with the API running and the ingest CLI writing to the same
 * directory: the API kept answering with zero rows, and a restart did not fix it
 * because the server flushed its own stale state back over the file on shutdown.
 *
 * That is the worst possible failure mode, because every part of it looks like
 * success. The ingest reports rows written, the API reports a valid empty
 * result, and nothing anywhere says the two disagree. Somebody would reasonably
 * conclude the ingest is broken and go looking in the wrong place.
 *
 * So it is made impossible rather than documented: the second process refuses to
 * start and says exactly what to do instead.
 */
function acquirePgliteLock(dir: string): void {
  const lockPath = lockPathFor(dir)

  if (existsSync(lockPath)) {
    let holder: { pid: number; startedAt: string; argv: string } | null = null
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'))
    } catch {
      // An unreadable lock is a leftover from a hard kill, not a live holder.
    }

    if (holder && isProcessAlive(holder.pid)) {
      throw new Error(
        [
          `Another process is already using the embedded database at ${dir}.`,
          '',
          `  Held by PID ${holder.pid} since ${holder.startedAt}`,
          `  ${holder.argv}`,
          '',
          'PGlite is single-process: two processes on one directory do not share',
          'it, they overwrite each other, and the symptom is an API that reports',
          'zero rows while the ingest reports success.',
          '',
          'Either stop that process first, or use a real Postgres so the API and',
          'the ingest can run at the same time:',
          '',
          '  docker compose up -d db',
          '  DATABASE_URL=postgres://storedata:storedata@localhost:55432/storedata',
        ].join('\n'),
      )
    }

    // Stale lock: the holder is gone.
    rmSync(lockPath, { force: true })
  }

  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      argv: process.argv.slice(1).join(' '),
    }),
    'utf8',
  )

  // Release on any exit path, including an unhandled throw.
  const release = () => releasePgliteLock(dir)
  process.once('exit', release)
  process.once('SIGINT', release)
  process.once('SIGTERM', release)
}

function releasePgliteLock(dir: string): void {
  try {
    rmSync(lockPathFor(dir), { force: true })
  } catch {
    // Losing the lock file on the way out is not worth failing a shutdown over;
    // the next start treats an unreadable or orphaned lock as stale anyway.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

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
    // PGlite creates its own data directory but NOT the parent of it, and the
    // failure without one is `Failed query: CREATE SCHEMA` from the migrator,
    // which says nothing about the actual cause. A clean clone has no data/
    // because git cannot track an empty directory, so following the README
    // exactly used to fail on the first command.
    mkdirSync(dirname(config.pgliteDir), { recursive: true })

    acquirePgliteLock(config.pgliteDir)
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
    releasePgliteLock(config.pgliteDir)
  }
  db = null
}

export { schema }
