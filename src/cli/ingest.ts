/**
 * Ingest CLI.
 *
 *   bun run ingest seed        --country us --lang en [--categories 3] [--source play,ios,steam]
 *   bun run ingest promote     --limit 200
 *   bun run ingest drain       --limit 50
 *   bun run ingest app         --source play --id com.google.android.apps.translate
 *   bun run ingest renormalize --source play --limit 500
 *
 * `seed` discovers, `drain` downloads. They are separate commands for the same
 * reason they are separate tables: discovery is cheap and safe, downloading is
 * expensive and blockable, and one must never turn straight into the other.
 */
import { config } from '../config.ts'
import { PLAY_INGESTABLE_CATEGORY_IDS } from '../data/categories.ts'
import { closeDb, getDb } from '../db/client.ts'
import { runMigrations } from '../db/migrate.ts'
import { logger } from '../lib/logger.ts'
import { allPacerStates } from '../lib/pacer.ts'
import type { Source } from '../normalize/contract.ts'
import {
  discoverFromAppleChart,
  discoverFromPlayRanking,
  discoverFromSteamMostPlayed,
} from '../services/discovery.ts'
import { ingestApp, renormalize } from '../services/ingest.ts'
import { prefillSteamSpy } from '../services/steamspy-prefill.ts'
import { drainQueue, promoteDiscoveries, queueStats, discoveryStats } from '../services/worker.ts'

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index === process.argv.length - 1) return fallback
  return process.argv[index + 1]
}

function intArg(name: string, fallback: number): number {
  const raw = arg(name)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const command = process.argv[2] ?? 'help'
const country = arg('country', config.DEFAULT_COUNTRY) as string
const lang = arg('lang', config.DEFAULT_LANG) as string
const sources = (arg('source', 'play,ios,steam') as string)
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Source => s === 'play' || s === 'ios' || s === 'steam')

async function seed(): Promise<void> {
  const categoryLimit = intArg('categories', 3)
  const perList = intArg('num', 50)
  let discovered = 0
  let enqueued = 0

  if (sources.includes('play')) {
    // Rankings first: best ratio of apps discovered to requests spent, and they
    // are the apps that actually carry traffic.
    const categories = PLAY_INGESTABLE_CATEGORY_IDS.slice(0, categoryLimit)
    for (const categoryId of categories) {
      for (const collection of ['TOP_FREE', 'TOP_PAID', 'GROSSING'] as const) {
        try {
          const result = await discoverFromPlayRanking({
            collection,
            categoryId,
            country,
            lang,
            num: perList,
          })
          discovered += result.discovered
          enqueued += result.enqueued
          logger.info('seeded from play ranking', { collection, categoryId, ...result })
        } catch (error) {
          logger.warn('play ranking seed failed', { collection, categoryId, error: String(error) })
        }
      }
    }
  }

  if (sources.includes('ios')) {
    for (const chart of ['top-free', 'top-paid'] as const) {
      try {
        const result = await discoverFromAppleChart({ chart, country, lang, limit: perList })
        discovered += result.discovered
        enqueued += result.enqueued
        logger.info('seeded from apple chart', { chart, ...result })
      } catch (error) {
        logger.warn('apple chart seed failed', { chart, error: String(error) })
      }
    }
  }

  if (sources.includes('steam')) {
    try {
      const result = await discoverFromSteamMostPlayed({ country, lang })
      discovered += result.discovered
      enqueued += result.enqueued
      logger.info('seeded from steam most played', { ...result })
    } catch (error) {
      logger.warn('steam seed failed', { error: String(error) })
    }
  }

  logger.info('seed finished', { discovered, enqueued, discovery: await discoveryStats() })
}

async function main(): Promise<void> {
  await runMigrations(getDb())

  switch (command) {
    case 'seed':
      await seed()
      break

    case 'promote': {
      const promoted = await promoteDiscoveries({
        limit: intArg('limit', 200),
        country,
        lang,
        ...(sources.length === 1 && sources[0] ? { source: sources[0] } : {}),
      })
      logger.info('promote finished', { promoted, queue: await queueStats() })
      break
    }

    case 'drain': {
      const started = Date.now()
      const result = await drainQueue(intArg('limit', 50))
      const elapsed = (Date.now() - started) / 1000
      logger.info('drain finished', {
        ...result,
        seconds: Number(elapsed.toFixed(1)),
        per_hour: result.processed > 0 ? Math.round((result.processed / elapsed) * 3600) : 0,
        queue: await queueStats(),
        pacers: allPacerStates(),
      })
      break
    }

    case 'app': {
      const source = (arg('source', 'play') as string).split(',')[0] as Source
      const id = arg('id')
      if (!id) throw new Error('--id is required')
      const outcome = await ingestApp(source, id, {
        country,
        lang,
        resolveIosMatch: source === 'play',
      })
      logger.info('single app ingest', outcome as unknown as Record<string, unknown>)
      break
    }

    case 'renormalize': {
      const source = (arg('source', 'play') as string).split(',')[0] as Source
      const result = await renormalize({ source, limit: intArg('limit', 500) })
      logger.info('renormalize finished', result)
      break
    }

    case 'steamspy': {
      // Bulk review counts: 1,000 games per request instead of one request per
      // game. Run this BEFORE draining Steam, so the drain can skip appreviews.
      const result = await prefillSteamSpy({ pages: intArg('pages', 3) })
      logger.info('steamspy prefill finished', { ...result })
      break
    }

    case 'status':
      logger.info('queues', { ingest: await queueStats(), discovery: await discoveryStats() })
      break

    default:
      console.log(
        [
          'Usage: bun run ingest <command> [options]',
          '',
          'Commands:',
          '  seed         discover app ids from rankings and charts (no listings fetched)',
          '  promote      move discovered ids into the paced fetch queue',
          '  drain        fetch and store listings from the queue',
          '  app          fetch one listing now  (--source play --id com.example)',
          '  steamspy     bulk pre-fill Steam review counts (1000 games per request)',
          '  renormalize  rebuild listings from stored raw payloads, no network',
          '  status       queue depths',
          '',
          'Options: --country us --lang en --source play,ios,steam --limit N --categories N --num N',
        ].join('\n'),
      )
  }
}

try {
  await main()
  await closeDb()
  process.exit(0)
} catch (error) {
  logger.error('ingest cli failed', { error: String(error) })
  await closeDb().catch(() => undefined)
  process.exit(1)
}
