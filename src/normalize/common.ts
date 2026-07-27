/**
 * Cross-store equivalents.
 *
 * The rule that shapes this file: a canonical field keeps its platform-specific
 * meaning and stays null where it does not apply. `androidVersion` on an App
 * Store listing is null and that is correct, because writing "15.0" into a field
 * named `androidVersion` would assert something false.
 *
 * What `common` does is answer the question underneath: "what does this need to
 * run", "how big is it", "how well reviewed is it". Those have answers on all
 * three stores, in different fields with different shapes. Here they get one
 * shape, and every value records the field it came from so a consumer can trace
 * it rather than trusting a normalisation they cannot see.
 *
 * WHAT IS AND IS NOT COMMONISED
 *
 * Paired, so they live here:
 *   minimumOs           androidVersion | minimumOsVersion | pc_requirements
 *   downloadSizeBytes   -              | fileSizeBytes    | -
 *   supportedLanguages  -              | languageCodesISO2A | supported_languages
 *   publisher           -              | sellerName       | publishers[0]
 *   reviewSummary       histogram (derived) | -           | appreviews / SteamSpy
 *
 * NOT paired, so they stay in `extra` under their own source:
 *   metacritic          Steam only, no counterpart anywhere
 *   platforms, dlc      Steam only
 *   supportedDevices    Apple only, an enumeration with no analogue
 *   installs            Play only. Apple publishes nothing and Steam publishes
 *                       nothing; SteamSpy's owner estimate is a third-party guess
 *                       spanning an order of magnitude ("100M .. 200M") and is
 *                       NOT presented as an install count. It stays in
 *                       extra.steam.steamSpy, labelled.
 *   editorsChoice       Play concept; Apple's editorial is a different mechanic
 *                       and the API does not expose it anyway
 */
import type {
  CanonicalApp,
  CommonBlock,
  Histogram,
  MinimumOs,
  ReviewSummary,
} from './contract.ts'
import { emptyCommon } from './contract.ts'
import { decodeEntities } from '../lib/html.ts'

// ---------------------------------------------------------------------------
// Minimum OS
// ---------------------------------------------------------------------------

/**
 * Google Play reports `VARY` when the requirement depends on the device. That is
 * a real answer, not a missing one, so the text is preserved and the comparable
 * version is null.
 */
export function playMinimumOs(core: CanonicalApp): MinimumOs | null {
  const raw = core.androidVersion
  const text = core.androidVersionText
  if (raw === null && text === null) return null

  const comparable = raw !== null && raw !== 'VARY' ? raw : null
  return {
    platform: 'android',
    version: comparable,
    text: text ?? (raw === 'VARY' ? 'Varies with device' : raw),
    sourceField: 'androidVersion',
  }
}

export function iosMinimumOs(minimumOsVersion: string | null): MinimumOs | null {
  if (minimumOsVersion === null) return null
  return {
    platform: 'ios',
    version: minimumOsVersion,
    text: `iOS ${minimumOsVersion} or later`,
    sourceField: 'minimumOsVersion',
  }
}

/** Matches the `OS: Windows 10` line inside Steam's requirements markup. */
const STEAM_OS_LINE = /<strong>\s*OS[^<]*:?\s*<\/strong>\s*([^<]+)/i

/**
 * `\W*` rather than `\s*` between the name and the number.
 *
 * Valve's own text for Counter-Strike 2 is "Windows® 10". Requiring whitespace
 * there means the trademark symbol silently blocks every version match, which is
 * how this shipped null for the most-played game on the platform.
 */
const WINDOWS_VERSION = /windows\W*(11|10|8\.1|8|7|xp|vista)\b/i

/**
 * Steam states requirements as free-form HTML written by the publisher, so this
 * is deliberately conservative: it reports the platform confidently (that comes
 * from a structured field) and a version only when the text is unambiguous.
 * Anything else leaves `version` null rather than guessing from prose.
 */
export function steamMinimumOs(details: Record<string, unknown>): MinimumOs | null {
  const platforms = details.platforms as Record<string, unknown> | undefined
  const platform =
    platforms?.windows === true
      ? 'windows'
      : platforms?.mac === true
        ? 'macos'
        : platforms?.linux === true
          ? 'linux'
          : null

  if (platform === null) return null

  const requirements = details.pc_requirements as Record<string, unknown> | undefined
  const minimum = typeof requirements?.minimum === 'string' ? requirements.minimum : null

  let text: string | null = null
  let version: string | null = null

  if (minimum) {
    const match = STEAM_OS_LINE.exec(minimum)
    if (match?.[1]) {
      text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 120) || null
      const versionMatch = text ? WINDOWS_VERSION.exec(text) : null
      if (versionMatch?.[1]) version = versionMatch[1]
    }
  }

  return {
    platform,
    version,
    text: text ?? (platform === 'windows' ? 'Windows' : platform === 'macos' ? 'macOS' : 'Linux'),
    sourceField: minimum ? 'pc_requirements.minimum' : 'platforms',
  }
}

// ---------------------------------------------------------------------------
// Review summary
// ---------------------------------------------------------------------------

/**
 * Google Play publishes a full five-star histogram, which is strictly richer
 * than a positive/negative split. Collapsing it to one makes Play comparable
 * with Steam, so it is done here and marked as derived. The histogram itself is
 * untouched and remains the better field for anyone who wants it.
 *
 * Three-star ratings are excluded from both sides rather than being forced into
 * one. On Steam a review is a thumbs up or down with no middle; the closest
 * honest analogue is to drop the middle rather than to invent a side for it. The
 * count dropped is stated in `derivedFrom` so nobody has to reverse-engineer why
 * `total` is smaller than `ratings`.
 */
export function reviewSummaryFromHistogram(histogram: Histogram | null): ReviewSummary | null {
  if (histogram === null) return null

  const positive = (histogram['4'] ?? 0) + (histogram['5'] ?? 0)
  const negative = (histogram['1'] ?? 0) + (histogram['2'] ?? 0)
  const neutral = histogram['3'] ?? 0
  const total = positive + negative
  if (total === 0) return null

  return {
    positive,
    negative,
    total,
    percentPositive: Number(((positive / total) * 100).toFixed(1)),
    // Google publishes no wording for this; inventing one would be a fabrication.
    label: null,
    provenance: {
      provider: 'play',
      authoritative: true,
      fetchedAt: null,
      derivedFrom:
        `histogram: 4-5 stars counted positive, 1-2 negative, ` +
        `${neutral} three-star ratings excluded as neutral`,
    },
  }
}

export interface SteamReviewNumbers {
  positive: number | null
  negative: number | null
  total: number | null
  label: string | null
}

/**
 * Valve's own numbers. Authoritative: this is the store reporting on itself.
 */
export function reviewSummaryFromValve(
  numbers: SteamReviewNumbers,
  fetchedAt: string | null = null,
): ReviewSummary | null {
  const { positive, negative } = numbers
  if (positive === null && negative === null) return null

  const total = numbers.total ?? (positive ?? 0) + (negative ?? 0)
  if (total === 0) return null

  return {
    positive,
    negative,
    total,
    percentPositive:
      positive === null ? null : Number(((positive / total) * 100).toFixed(1)),
    label: numbers.label,
    provenance: { provider: 'steam', authoritative: true, fetchedAt },
  }
}

/**
 * SteamSpy's numbers. NOT authoritative, and marked as such on every record.
 *
 * Measured against Valve on 2026-07-27 they run about 9 percent low on absolute
 * counts while staying within a point on the ratio, so they are a reasonable
 * stand-in for the percentage and a poor one for the count. Serving them without
 * the flag would make a stale third-party number indistinguishable from the
 * store's own.
 */
export function reviewSummaryFromSteamSpy(
  numbers: { positive: number | null; negative: number | null },
  fetchedAt: string | null = null,
): ReviewSummary | null {
  const { positive, negative } = numbers
  if (positive === null && negative === null) return null

  const total = (positive ?? 0) + (negative ?? 0)
  if (total === 0) return null

  return {
    positive,
    negative,
    total,
    percentPositive: positive === null ? null : Number(((positive / total) * 100).toFixed(1)),
    // SteamSpy does not publish Valve's wording, and guessing the band from the
    // percentage would put words in Valve's mouth.
    label: null,
    provenance: {
      provider: 'steamspy',
      authoritative: false,
      fetchedAt,
      derivedFrom: 'SteamSpy bulk export; counts lag Valve and are approximate',
    },
  }
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Steam writes this as display markup: `English<strong>*</strong>, French, ...`
 * with a trailing note about which have full audio. Tags and the note are
 * stripped and the rest is split on commas.
 */
export function steamLanguages(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []

  // Order matters: split on the line break FIRST, then strip the remaining tags.
  // Stripping first removes the <br> that marks where the language list ends and
  // the footnote begins, and the footnote then parses as another language.
  const beforeFootnote = decodeEntities(raw).split(/<br\s*\/?>/i)[0] ?? ''

  return beforeFootnote
    .replace(/<[^>]+>/g, '')
    .split(',')
    .map((s) => s.replace(/\*/g, '').trim())
    .filter((s) => s.length > 0 && s.length < 40)
    .slice(0, 60)
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildCommon(parts: Partial<CommonBlock>): CommonBlock {
  return { ...emptyCommon(), ...parts }
}

/**
 * Ranking placements are attached at read time, not at normalisation time: they
 * change on their own schedule and belong to the chart, not to the listing.
 */
export function attachRankings(
  common: CommonBlock,
  rankings: CommonBlock['rankings'],
): CommonBlock {
  const sorted = [...rankings].sort((a, b) => a.position - b.position)
  return { ...common, rankings: sorted, bestRank: sorted[0] ?? null }
}
