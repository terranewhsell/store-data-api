/**
 * GET /v1/status
 *
 * Behind the same Bearer token as everything else, because it exposes exactly the
 * operational detail an attacker would like: what is failing and when we are
 * blocked.
 *
 * It exists because an ingest that quietly stops is the most expensive failure
 * there is. Nobody notices until the data is stale and the pages built from it
 * are wrong. This answers, in one request: how much do we have, how old is the
 * oldest, what failed in the last 24 hours, and is the queue actually moving.
 */
import { Hono } from 'hono'
import { getStatus } from '../../services/status.ts'

export const statusRoutes = new Hono()

statusRoutes.get('/status', async (c) => {
  const status = await getStatus()
  // 200 even when unhealthy: the body carries the verdict, and a monitor that
  // only looks at the status code should see the service answering. `healthy`
  // and `warnings` are what a human or an alert rule reads.
  return c.json(status)
})
