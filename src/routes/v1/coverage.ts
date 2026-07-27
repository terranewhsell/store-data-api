/**
 * GET /v1/coverage
 *
 * What each source covers, what it does not, and why.
 *
 * This endpoint exists so that an empty field never has to be interpreted. A
 * consumer who sees `installs: null` on an App Store listing can ask this route
 * and get "Apple publishes no install counts anywhere" rather than filing a bug
 * against us. It is the difference between a documented limit of the store and
 * an apparent failure of the integration.
 *
 * It reports two different things per field, deliberately:
 *
 *   declared  what the source CAN provide. A property of the store.
 *   fillRate  what it ACTUALLY provided across our stored listings. A property
 *             of the developers who wrote those listings.
 *
 * A field with `declared: null` and a 60 percent fill rate is working correctly:
 * four listings in ten simply left it blank.
 */
import { Hono } from 'hono'
import { buildCoverageReport } from '../../services/coverage-report.ts'
import { resolveSources } from '../../lib/request-context.ts'

export const coverageRoutes = new Hono()

coverageRoutes.get('/coverage', async (c) => {
  const report = await buildCoverageReport()
  const wanted = resolveSources(c)

  // `?source=ios` narrows it; the full report is three sources by fifty-eight
  // fields and is a lot to read when you only care about one.
  const sources =
    wanted.length > 0 ? report.sources.filter((s) => wanted.includes(s.source)) : report.sources

  // `?only=gaps` is the view you want when writing a page template: just the
  // fields that will be empty, and the reason for each.
  const only = c.req.query('only')?.trim().toLowerCase()
  if (only === 'gaps') {
    return c.json({
      generated_at: report.generated_at,
      legend: report.legend,
      sources: sources.map((s) => ({
        source: s.source,
        listings: s.listings,
        gaps: s.fields
          .filter((f) => f.declared !== null)
          .map((f) => ({ field: f.field, reason: f.declared })),
        common: s.common,
        notes: s.notes,
      })),
    })
  }

  return c.json({ ...report, sources })
})
