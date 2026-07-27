/**
 * Migration runner.
 *
 * Applies the drizzle-generated migrations, then the hand-written statements in
 * post-migration.sql that drizzle-kit cannot express (expression indexes, partial
 * indexes). Works against either driver, because both are Postgres.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import { config } from '../config.ts'
import { logger } from '../lib/logger.ts'
import { closeDb, getDb, type Database } from './client.ts'
import type * as schema from './schema.ts'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_FOLDER = join(here, '..', '..', 'drizzle')
const POST_MIGRATION = join(here, 'post-migration.sql')

/** Splits on semicolons at end of line, which is enough for our own DDL file. */
function splitStatements(source: string): string[] {
  return source
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^--/.test(s.replace(/\n/g, ' ').trim()))
}

export async function runMigrations(database: Database = getDb()): Promise<void> {
  logger.info('running migrations', { driver: config.driver, folder: MIGRATIONS_FOLDER })

  if (config.driver === 'pglite') {
    await migratePglite(database as unknown as PgliteDatabase<typeof schema>, {
      migrationsFolder: MIGRATIONS_FOLDER,
    })
  } else {
    await migratePg(database as unknown as PostgresJsDatabase<typeof schema>, {
      migrationsFolder: MIGRATIONS_FOLDER,
    })
  }

  const post = await readFile(POST_MIGRATION, 'utf8')
  for (const statement of splitStatements(post)) {
    await database.execute(sql.raw(statement))
  }

  logger.info('migrations applied')
}

if (import.meta.main) {
  try {
    await runMigrations()
    await closeDb()
    process.exit(0)
  } catch (error) {
    logger.error('migration failed', { error: String(error) })
    await closeDb().catch(() => undefined)
    process.exit(1)
  }
}
