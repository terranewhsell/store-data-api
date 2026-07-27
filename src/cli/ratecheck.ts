/**
 * Rate check.
 *
 *   bun run ratecheck --source play --n 20
 *
 * Measures what each source actually sustains from THIS machine and THIS IP,
 * rather than repeating a number from documentation. The brief is blunt about
 * why: do not promise a volume you have not measured.
 *
 * It reports the achieved rate, the failure mix, and the projected apps per hour
 * at the configured pacing. That last figure is the one to quote to a client, and
 * only after this has run.
 */
import { config } from '../config.ts'
import { closeDb, getDb } from '../db/client.ts'
import { runMigrations } from '../db/migrate.ts'
import { logger } from '../lib/logger.ts'
import { allPacerStates } from '../lib/pacer.ts'
import { isSourceError } from '../lib/source-errors.ts'
import type { Source } from '../normalize/contract.ts'
import * as ios from '../sources/ios.ts'
import * as play from '../sources/play.ts'
import * as steam from '../sources/steam.ts'

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index === process.argv.length - 1) return fallback
  return process.argv[index + 1]
}

/** Real, long-lived ids. Nothing here is fetched more than once per run. */
const PROBES: Record<Source, string[]> = {
  play: [
    'com.google.android.apps.translate',
    'com.whatsapp',
    'com.spotify.music',
    'com.instagram.android',
    'com.duolingo',
    'org.telegram.messenger',
    'com.netflix.mediaclient',
    'com.dropbox.android',
    'com.adobe.reader',
    'com.microsoft.office.outlook',
  ],
  ios: [
    'id284882215',
    'id324684580',
    'id389801252',
    'id570060128',
    'id310633997',
    'id686449807',
    'id363590051',
    'id327630330',
    'id469337564',
    'id951937596',
  ],
  steam: ['440', '730', '570', '292030', '271590', '1091500', '620', '400', '105600', '322330'],
}

async function probe(source: Source, id: string, country: string, lang: string): Promise<void> {
  if (source === 'play') {
    await play.fetchApp({ appId: id, country, lang })
    return
  }
  if (source === 'ios') {
    await ios.lookupOne(id, { country, lang })
    return
  }
  await steam.fetchAppDetails(id, { country, lang })
}

async function main(): Promise<void> {
  await runMigrations(getDb())

  const source = (arg('source', 'play') as string) as Source
  const requested = Number.parseInt(arg('n', '10') as string, 10)
  const country = arg('country', config.DEFAULT_COUNTRY) as string
  const lang = arg('lang', config.DEFAULT_LANG) as string

  const pool = PROBES[source] ?? []
  const n = Math.max(1, Math.min(requested, pool.length))
  const ids = pool.slice(0, n)

  logger.info('rate check starting', {
    source,
    requests: n,
    configured_interval_ms:
      source === 'play'
        ? [config.RATE_PLAY_MIN_INTERVAL_MS, config.RATE_PLAY_MAX_INTERVAL_MS]
        : source === 'ios'
          ? [config.RATE_IOS_MIN_INTERVAL_MS, config.RATE_IOS_MAX_INTERVAL_MS]
          : [config.RATE_STEAM_MIN_INTERVAL_MS, config.RATE_STEAM_MAX_INTERVAL_MS],
  })

  const started = Date.now()
  const outcomes: Record<string, number> = {}
  const latencies: number[] = []

  for (const id of ids) {
    const at = Date.now()
    try {
      await probe(source, id, country, lang)
      outcomes.ok = (outcomes.ok ?? 0) + 1
    } catch (error) {
      const kind = isSourceError(error) ? error.kind : 'unknown'
      outcomes[kind] = (outcomes[kind] ?? 0) + 1
      logger.warn('probe failed', { source, id, kind, error: String(error) })
      // A block mid-run is itself the answer. Stop rather than confirm it nine
      // more times.
      if (kind === 'blocked' || kind === 'rate_limited') {
        logger.error('stopping early: the source started refusing requests', { after: latencies.length })
        break
      }
    }
    latencies.push(Date.now() - at)
  }

  const elapsedSeconds = (Date.now() - started) / 1000
  const completed = latencies.length
  const successes = outcomes.ok ?? 0
  const perHour = completed > 0 ? Math.round((successes / elapsedSeconds) * 3600) : 0
  const sorted = [...latencies].sort((a, b) => a - b)

  logger.info('rate check finished', {
    source,
    requests_attempted: completed,
    outcomes,
    elapsed_seconds: Number(elapsedSeconds.toFixed(1)),
    achieved_per_hour: perHour,
    latency_ms: {
      min: sorted[0] ?? null,
      median: sorted[Math.floor(sorted.length / 2)] ?? null,
      max: sorted[sorted.length - 1] ?? null,
    },
    pacer: allPacerStates().find((p) => p.source === source),
    note: 'achieved_per_hour is measured from this IP right now. Quote this, not a documented limit.',
  })
}

try {
  await main()
  await closeDb()
  process.exit(0)
} catch (error) {
  logger.error('rate check failed', { error: String(error) })
  await closeDb().catch(() => undefined)
  process.exit(1)
}
