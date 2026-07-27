import { defineConfig } from 'drizzle-kit'

/**
 * `drizzle-kit generate` produces the SQL from src/db/schema.ts, so the migration
 * and the typed schema cannot drift apart. Applying it is done by
 * `bun run db:migrate`, which works against either driver.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://storedata:storedata@localhost:55432/storedata',
  },
  strict: true,
  verbose: true,
})
