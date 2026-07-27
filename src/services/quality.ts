/**
 * Ingest quality gates.
 *
 * A catalogue full of empty listings is worse than a smaller complete one: the
 * empty pages get built, indexed and then penalised, and the only signal that
 * anything went wrong is a row that exists. So a record that arrives without the
 * things that make it a listing is not stored as valid. It is logged as
 * incomplete and retried later.
 *
 * The gate is deliberately about substance, not completeness. Plenty of real apps
 * have no video and no privacy policy; none of them have no title.
 */
import type { CanonicalApp, Source } from '../normalize/contract.ts'

export interface QualityVerdict {
  ok: boolean
  reasons: string[]
}

/** Without these there is no listing at all. */
function hasIdentity(core: CanonicalApp): string[] {
  const problems: string[] = []
  if (!core.title || core.title.trim().length === 0) problems.push('missing_title')
  if (!core.appId || core.appId.trim().length === 0) problems.push('missing_app_id')
  return problems
}

/**
 * Without at least one of these the page has nothing to show. An icon alone is
 * not a page; a description alone can be. One of the two is the floor.
 */
function hasSubstance(core: CanonicalApp): string[] {
  const hasDescription =
    (core.description !== null && core.description.trim().length >= 40) ||
    (core.summary !== null && core.summary.trim().length >= 20)
  const hasImagery = core.icon !== null || core.screenshots.length > 0
  return hasDescription || hasImagery ? [] : ['no_description_and_no_imagery']
}

export function checkQuality(core: CanonicalApp, _source: Source): QualityVerdict {
  const reasons = [...hasIdentity(core), ...hasSubstance(core)]
  return { ok: reasons.length === 0, reasons }
}

/**
 * Richness score, 0..1. Not a gate: a signal, so `/v1/status` can report whether
 * the catalogue is getting thinner over time instead of only whether it is
 * growing.
 */
export function richness(core: CanonicalApp): number {
  const checks = [
    core.title !== null,
    core.description !== null && core.description.length > 200,
    core.descriptionHTML !== null,
    core.summary !== null,
    core.icon !== null,
    core.screenshots.length >= 3,
    core.score !== null,
    core.ratings !== null,
    core.developer !== null,
    core.genre !== null,
    core.categories.length > 0,
    core.contentRating !== null,
    core.released !== null || core.updated !== null,
    core.price !== null,
    core.url !== null,
  ]
  const passed = checks.filter(Boolean).length
  return Number((passed / checks.length).toFixed(3))
}
