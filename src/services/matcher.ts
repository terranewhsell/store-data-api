/**
 * Cross-store matching for `iosId`.
 *
 * Google Play and the App Store share no identifier, so the link has to be
 * inferred from the app name and the developer name. The governing rule is that
 * a wrong link is worse than no link: it sends a user to a different product, and
 * unlike a null it looks correct.
 *
 * So the bar is high and deliberately conservative:
 *   - both the title and the developer must be similar, not just one
 *   - a strong second candidate disqualifies the first, because "Solitaire" by
 *     two different studios is the normal case, not the edge case
 *   - anything short of confident leaves the field null and files the candidates
 *     for review, so a later pass does not repeat the search
 */
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client.ts'
import { appLocales } from '../db/schema.ts'
import { lookup, search as iosSearch, type ItunesApp } from '../sources/ios.ts'
import { logger } from '../lib/logger.ts'
import { isSourceError } from '../lib/source-errors.ts'

/** Above this a single leading candidate is accepted automatically. */
export const ACCEPT_THRESHOLD = 0.86
/** Below this the candidate is not even worth storing for review. */
export const REVIEW_THRESHOLD = 0.55
/** The leader must beat the runner-up by this much to be trusted. */
export const MIN_LEAD = 0.08

/** Lowercase, strip punctuation and the marketing noise stores put in titles. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    /**
     * Everything after a separator is usually a tagline, not the name:
     * "Duolingo - Language Lessons", "Notion: notes, docs, tasks".
     *
     * The separator needs whitespace AFTER it but not before, because stores
     * write "Notion: notes" with no leading space. Requiring the trailing space
     * is what protects hyphenated names: "Wi-Fi Analyzer" and "e-book Reader"
     * have no space after the dash, so they survive intact.
     */
    .replace(/\s*[-–—:|]\s+.*$/, '')
    .replace(/\((?:free|lite|pro|hd|premium)\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Damerau-free Levenshtein, iterative, O(n*m) with a single row buffer. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length] as number
}

/** 1 for identical, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const left = normalizeName(a)
  const right = normalizeName(b)
  if (left.length === 0 || right.length === 0) return 0
  if (left === right) return 1
  const distance = levenshtein(left, right)
  const longest = Math.max(left.length, right.length)
  return Number(Math.max(0, 1 - distance / longest).toFixed(4))
}

export interface MatchCandidate {
  candidateSource: 'ios'
  candidateSourceId: string
  candidateTitle: string | null
  candidateDeveloper: string | null
  titleSimilarity: number
  developerSimilarity: number
  confidence: number
  decision: 'accepted' | 'rejected' | 'review'
  method: string
}

export interface MatchOutcome {
  match: { iosId: string; confidence: number; method: string } | null
  candidates: MatchCandidate[]
}

/**
 * The developer name carries less weight than the title: stores spell the same
 * company differently ("Google LLC" vs "Google"), so a weak developer match with
 * an exact title is common and legitimate. It is still required to be non-trivial,
 * which is what stops two unrelated "Solitaire" apps from linking.
 */
function confidenceOf(titleSim: number, devSim: number): number {
  return Number((titleSim * 0.7 + devSim * 0.3).toFixed(4))
}

function scoreCandidate(
  playTitle: string,
  playDeveloper: string | null,
  candidate: ItunesApp,
  method: string,
): MatchCandidate {
  const candidateTitle = typeof candidate.trackName === 'string' ? candidate.trackName : null
  const candidateDeveloper =
    typeof candidate.artistName === 'string'
      ? candidate.artistName
      : typeof candidate.sellerName === 'string'
        ? candidate.sellerName
        : null

  const titleSimilarity = candidateTitle ? similarity(playTitle, candidateTitle) : 0
  const developerSimilarity =
    playDeveloper && candidateDeveloper ? similarity(playDeveloper, candidateDeveloper) : 0

  return {
    candidateSource: 'ios',
    candidateSourceId: `id${candidate.trackId}`,
    candidateTitle,
    candidateDeveloper,
    titleSimilarity,
    developerSimilarity,
    confidence: confidenceOf(titleSimilarity, developerSimilarity),
    decision: 'review',
    method,
  }
}

/**
 * Candidates from our OWN index, with no outbound call at all.
 *
 * This is the primary path, for two reasons. It is free, and Apple's Search API
 * is only intermittently available: under a burst it answers 403 for every query
 * while `/lookup` on the same host keeps working, then recovers minutes later.
 * Matching one app at a time against a throttled endpoint would make the
 * cross-link rate depend on Apple's mood.
 *
 * Since App Store listings are ingested from Apple's charts and looked up in
 * batches of 200, the local index is where the counterpart usually already is.
 */
async function localCandidates(
  play: { title: string; developer: string | null },
  opts: { country: string; lang: string },
): Promise<MatchCandidate[]> {
  const db = getDb()
  const normalized = normalizeName(play.title)
  // First meaningful token, wide enough to catch the row, narrow enough that the
  // index does the work rather than a sequential scan.
  const token = normalized.split(' ')[0] ?? normalized
  if (token.length < 2) return []

  const rows = await db
    .select({
      sourceId: appLocales.sourceId,
      title: appLocales.title,
      developer: appLocales.developer,
    })
    .from(appLocales)
    .where(
      and(
        eq(appLocales.source, 'ios'),
        eq(appLocales.country, opts.country),
        eq(appLocales.lang, opts.lang),
        sql`lower(${appLocales.title}) LIKE ${`%${token}%`}`,
      ),
    )
    .limit(25)

  return rows.map((row) =>
    scoreCandidate(
      play.title,
      play.developer,
      {
        trackId: row.sourceId.replace(/^id/, ''),
        trackName: row.title ?? '',
        artistName: row.developer ?? '',
      } as unknown as ItunesApp,
      'local_index',
    ),
  )
}

/**
 * Finds the App Store counterpart of a Play listing.
 *
 * Order of attempts, cheapest and most certain first:
 *   1. our own index, no network
 *   2. Apple's search API, when it is reachable, for the bundle id shortcut and
 *      the name-plus-developer query
 *
 * Step 2 failing is not an error. It degrades the match rate, not the service,
 * and a match we cannot make confidently is a null rather than a guess.
 */
export async function matchPlayToIos(
  play: { title: string; developer: string | null; appId: string },
  opts: { country: string; lang: string },
): Promise<MatchOutcome> {
  const candidates: MatchCandidate[] = [...(await localCandidates(play, opts))]

  // An exact hit in the local index needs no outbound call at all.
  const localExact = candidates.find(
    (c) => c.titleSimilarity === 1 && c.developerSimilarity >= 0.5,
  )
  if (localExact && localExact.confidence >= ACCEPT_THRESHOLD) {
    localExact.decision = 'accepted'
    return {
      match: {
        iosId: localExact.candidateSourceId,
        confidence: localExact.confidence,
        method: 'local_index_exact',
      },
      candidates: [localExact],
    }
  }

  // 1. Same reverse-DNS identifier on both stores. Exact, not a guess.
  try {
    const byBundle = await iosSearch(play.appId, { ...opts, limit: 5 })
    for (const candidate of byBundle) {
      if (candidate.bundleId === play.appId) {
        const scored = scoreCandidate(play.title, play.developer, candidate, 'bundle_id_exact')
        scored.confidence = 1
        scored.decision = 'accepted'
        return {
          match: { iosId: scored.candidateSourceId, confidence: 1, method: 'bundle_id_exact' },
          candidates: [scored],
        }
      }
      candidates.push(scoreCandidate(play.title, play.developer, candidate, 'bundle_id_probe'))
    }
  } catch (error) {
    if (!isSourceError(error) || error.kind !== 'not_found') {
      logger.debug('bundle id probe unavailable, continuing on the local index', {
        appId: play.appId,
        error: String(error),
      })
    }
  }

  // 2. Name plus developer.
  const term = play.developer ? `${play.title} ${play.developer}` : play.title
  try {
    const results = await iosSearch(term, { ...opts, limit: 15 })
    for (const candidate of results) {
      candidates.push(scoreCandidate(play.title, play.developer, candidate, 'name_developer_search'))
    }
  } catch (error) {
    // Apple's search endpoint being refused must not fail the ingest. The local
    // candidates already gathered still get scored below.
    if (!isSourceError(error) || error.kind === 'blocked' || error.kind === 'rate_limited') {
      logger.debug('apple search unavailable, matching on the local index only', {
        appId: play.appId,
        error: String(error),
      })
    } else if (error instanceof Error && error.name === 'BreakerOpenError') {
      logger.debug('apple breaker open, matching on the local index only', { appId: play.appId })
    } else if (isSourceError(error) && error.kind !== 'not_found') {
      logger.debug('apple search failed', { appId: play.appId, kind: error.kind })
    }
  }

  // Deduplicate by candidate id, keeping the best score for each.
  const best = new Map<string, MatchCandidate>()
  for (const candidate of candidates) {
    const previous = best.get(candidate.candidateSourceId)
    if (!previous || candidate.confidence > previous.confidence) {
      best.set(candidate.candidateSourceId, candidate)
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.confidence - a.confidence)
  const leader = ranked[0]
  const runnerUp = ranked[1]

  if (!leader || leader.confidence < REVIEW_THRESHOLD) {
    return { match: null, candidates: ranked.slice(0, 5).map((c) => ({ ...c, decision: 'rejected' })) }
  }

  const clearLead = !runnerUp || leader.confidence - runnerUp.confidence >= MIN_LEAD
  const strongEnough = leader.confidence >= ACCEPT_THRESHOLD
  // A developer match near zero means we are matching on the title alone, which
  // is exactly how "Solitaire" links to the wrong studio's game.
  const developerAgrees = leader.developerSimilarity >= 0.5

  if (strongEnough && clearLead && developerAgrees) {
    leader.decision = 'accepted'
    return {
      match: {
        iosId: leader.candidateSourceId,
        confidence: leader.confidence,
        method: leader.method,
      },
      candidates: ranked.slice(0, 5),
    }
  }

  // Not confident: field stays null, candidates kept so review is cheap later.
  return { match: null, candidates: ranked.slice(0, 5) }
}

/** Confirms that an already-stored cross-link still resolves to a live listing. */
export async function verifyIosId(
  iosId: string,
  opts: { country: string; lang: string },
): Promise<boolean> {
  try {
    const results = await lookup([iosId], opts)
    return results.length > 0
  } catch {
    return false
  }
}
