/**
 * One-command catalogue build, safe to re-run.
 *
 *   bun run seed                                  # defaults below
 *   bun run seed --apps 2000 --categories 12 --markets us,es,mx
 *   bun run seed --source play --apps 500
 *
 * Runs the full cycle: discover, promote, fetch. It is idempotent by
 * construction: discovery deduplicates on insert and the fetch queue
 * deduplicates on a stable key, so running it again refreshes what is stale and
 * fills what is missing rather than duplicating anything.
 *
 * This is deliberately a SEPARATE command from the API process. It must run
 * somewhere that will not be suspended halfway through, which rules out a
 * free-tier web instance: those sleep after minutes of inactivity and would
 * leave the catalogue half written with no indication of where it stopped.
 * Run it from a developer machine or a CI job, pointed at the same database the
 * API reads.
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
import { getStatus } from '../services/status.ts'
import { drainQueue, promoteDiscoveries, queueStats } from '../services/worker.ts'

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

const targetApps = intArg('apps', 300)
const categoryCount = intArg('categories', 6)
const perList = intArg('num', 50)
const markets = (arg('markets', `${config.DEFAULT_COUNTRY}:${config.DEFAULT_LANG}`) as string)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)
  .map((m) => {
    const [country, lang] = m.includes(':') ? m.split(':') : [m, config.DEFAULT_LANG]
    return { country: country ?? config.DEFAULT_COUNTRY, lang: lang ?? config.DEFAULT_LANG }
  })

const sources = (arg('source', 'play,ios,steam') as string)
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Source => s === 'play' || s === 'ios' || s === 'steam')

/** Discovery only. Cheap, safe, and never turns straight into downloads. */
async function discover(): Promise<number> {
  let discovered = 0

  for (const market of markets) {
    if (sources.includes('play')) {
      const categories = PLAY_INGESTABLE_CATEGORY_IDS.slice(0, categoryCount)
      for (const categoryId of categories) {
        for (const collection of ['TOP_FREE', 'TOP_PAID', 'GROSSING'] as const) {
          try {
            const result = await discoverFromPlayRanking({
              collection,
              categoryId,
              country: market.country,
              lang: market.lang,
              num: perList,
            })
            discovered += result.discovered
          } catch (error) {
            // One category failing must not abandon the other fifty-three.
            logger.warn('play ranking failed, continuing', {
              collection,
              categoryId,
              market,
              error: String(error),
            })
          }
        }
      }
    }

    if (sources.includes('ios')) {
      for (const chart of ['top-free', 'top-paid'] as const) {
        try {
          const result = await discoverFromAppleChart({
            chart,
            country: market.country,
            lang: market.lang,
            limit: perList,
          })
          discovered += result.discovered
        } catch (error) {
          logger.warn('apple chart failed, continuing', { chart, market, error: String(error) })
        }
      }
    }
  }

  if (sources.includes('steam')) {
    const market = markets[0] ?? { country: config.DEFAULT_COUNTRY, lang: config.DEFAULT_LANG }
    try {
      const result = await discoverFromSteamMostPlayed(market)
      discovered += result.discovered
    } catch (error) {
      logger.warn('steam chart failed, continuing', { error: String(error) })
    }
  }

  return discovered
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  await runMigrations(getDb())

  logger.info('seed starting', {
    target_apps: targetApps,
    sources,
    markets,
    categories: categoryCount,
    note: 'discovery and fetching are separate phases; nothing is downloaded during discovery',
  })

  const discovered = await discover()
  logger.info('discovery finished', { discovered, queue: await queueStats() })

  /**
   * Fetch in batches, cycling through the sources.
   *
   * The queue is ordered by priority, and Play rankings outrank the Apple and
   * Steam charts because that is the right order for a full build. But it means
   * a small run drains entirely from Play and leaves /v1/steam empty, which
   * looks like a broken integration rather than a short run. So the budget is
   * split across the requested sources and each is promoted under its own
   * filter.
   *
   * A source that runs out of work early does not waste its share: the loop
   * keeps cycling and the remaining sources absorb the rest.
   */
  const BATCH = 25
  let fetched = 0
  const exhausted = new Set<Source>()

  for (const market of markets) {
    while (fetched < targetApps && exhausted.size < sources.length) {
      for (const source of sources) {
        if (fetched >= targetApps) break
        if (exhausted.has(source)) continue

        const share = Math.max(
          1,
          Math.min(
            BATCH,
            Math.ceil((targetApps - fetched) / Math.max(1, sources.length - exhausted.size)),
          ),
        )

        const promoted = await promoteDiscoveries({
          limit: share,
          country: market.country,
          lang: market.lang,
          source,
        })
        if (promoted === 0) {
          exhausted.add(source)
          continue
        }

        const before = Date.now()
        const result = await drainQueue(promoted)
        fetched += result.processed

        logger.info('batch done', {
          source,
          fetched,
          target: targetApps,
          batch_seconds: Number(((Date.now() - before) / 1000).toFixed(1)),
          market,
        })

        if (result.processed === 0) exhausted.add(source)
      }
    }
    exhausted.clear()
  }

  const elapsed = (Date.now() - startedAt) / 1000
  const status = await getStatus()

  logger.info('seed finished', {
    fetched,
    elapsed_seconds: Number(elapsed.toFixed(1)),
    per_hour: fetched > 0 ? Math.round((fetched / elapsed) * 3600) : 0,
    totals: status.totals,
    by_source: status.sources.map((s) => ({
      source: s.source,
      apps: s.apps,
      listings: s.listings,
      breaker: s.breaker.state,
    })),
    pacers: allPacerStates().map((p) => ({ source: p.source, sent: p.requestsSent, state: p.state })),
    healthy: status.healthy,
    warnings: status.warnings,
  })
}

try {
  await main()
  await closeDb()
  process.exit(0)
} catch (error) {
  logger.error('seed failed', { error: String(error) })
  await closeDb().catch(() => undefined)
  process.exit(1)
}
