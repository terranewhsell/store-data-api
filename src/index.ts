/**
 * Entry point.
 *
 * Migrations run at boot, so a deploy cannot serve against a schema it does not
 * have. The ingest worker starts only when explicitly enabled: starting a process
 * should never begin hitting the stores by surprise.
 */
import { createApp } from './app.ts'
import { config } from './config.ts'
import { closeDb, getDb } from './db/client.ts'
import { runMigrations } from './db/migrate.ts'
import { logger } from './lib/logger.ts'
import { startWorker, type WorkerHandle } from './services/worker.ts'

const app = createApp()
let worker: WorkerHandle | null = null

await runMigrations(getDb())

if (!config.API_BEARER_TOKEN) {
  // Not fatal: the service still starts and answers 503 store_no_token_configured
  // on every /v1 route, which is a far clearer signal than refusing to boot.
  logger.warn('API_BEARER_TOKEN is not set. Every /v1 route will answer 503 until it is.')
}

if (config.INGEST_WORKER_ENABLED) {
  worker = startWorker()
} else {
  logger.info('ingest worker disabled', {
    hint: 'set INGEST_WORKER_ENABLED=true, or run `bun run ingest` for a bounded pass',
  })
}

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
  // Long enough for a bulk export page, short enough that a stuck request frees.
  idleTimeout: 60,
})

logger.info('server listening', {
  port: server.port,
  driver: config.driver,
  env: config.NODE_ENV,
})

async function shutdown(signal: string): Promise<void> {
  logger.info('shutting down', { signal })
  worker?.stop()
  await worker?.done.catch(() => undefined)
  await server.stop(false)
  await closeDb().catch(() => undefined)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
