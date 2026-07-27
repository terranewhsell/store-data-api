/**
 * Application assembly.
 *
 * Every /v1 route sits behind the Bearer guard. `/health` does not, because a
 * load balancer needs to know the process is alive without holding a credential,
 * and it deliberately exposes nothing beyond that.
 */
import { Hono } from 'hono'
import { config } from './config.ts'
import { API_VERSION, isoNow } from './lib/envelope.ts'
import { requireBearer } from './lib/auth.ts'
import { ApiError, internal, notFound } from './lib/errors.ts'
import { logger } from './lib/logger.ts'
import { appsRoutes } from './routes/v1/apps.ts'
import { categoriesRoutes } from './routes/v1/categories.ts'
import { coverageRoutes } from './routes/v1/coverage.ts'
import { exportRoutes } from './routes/v1/export.ts'
import { searchRoutes } from './routes/v1/search.ts'
import { statusRoutes } from './routes/v1/status.ts'
import { steamRoutes } from './routes/v1/steam.ts'
import { topRoutes } from './routes/v1/top.ts'

export function createApp(): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    const startedAt = Date.now()
    await next()
    // Version on every response, and noindex: this is an API, its JSON has no
    // business in a search index.
    c.header('X-API-Version', API_VERSION)
    c.header('X-Robots-Tag', 'noindex, nofollow')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Response-Time', `${Date.now() - startedAt}ms`)
  })

  app.get('/health', (c) =>
    c.json({ status: 'ok', version: API_VERSION, generated_at: isoNow() }),
  )

  const v1 = new Hono()
  v1.use('*', requireBearer)
  v1.route('/', categoriesRoutes)
  v1.route('/', coverageRoutes)
  v1.route('/', appsRoutes)
  v1.route('/', steamRoutes)
  v1.route('/', searchRoutes)
  v1.route('/', topRoutes)
  v1.route('/', exportRoutes)
  v1.route('/', statusRoutes)

  app.route('/v1', v1)

  app.notFound(() => {
    throw notFound('No such route. See the README for the available endpoints.')
  })

  /**
   * One error shape for everything: `code`, `message`, `data.status`. Same form as
   * the coupons API, so their existing error handling works unchanged.
   *
   * Unexpected errors are logged in full and answered with a generic message. A
   * stack trace in a response body is an information leak, not a courtesy.
   */
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error.status >= 500) {
        logger.error('request failed', {
          code: error.code,
          status: error.status,
          path: c.req.path,
          message: error.message,
        })
      }
      return c.json(error.toBody(), error.httpStatus)
    }

    logger.error('unhandled error', {
      path: c.req.path,
      method: c.req.method,
      error: error instanceof Error ? error.message : String(error),
      stack: config.isProduction ? undefined : (error as Error)?.stack,
    })

    const fallback = internal()
    return c.json(fallback.toBody(), fallback.httpStatus)
  })

  return app
}
