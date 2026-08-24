/**
 * Rate limiting, in two layers.
 *
 * One global limit cannot serve both jobs this API needs done, because the two
 * threats have opposite shapes:
 *
 *   - A flood of unauthenticated requests must be stopped *before* any database
 *     work, or the session lookup itself becomes the denial of service. That
 *     wants an IP key and the earliest possible hook.
 *
 *   - Model calls cost real money per request, and must be limited per person.
 *     That wants a user key — and it cannot run before authentication, because
 *     there is no user to key on yet.
 *
 * Keying model spend by IP would also be actively wrong for this product. The
 * first users are in college hostels behind one NAT; an IP limit there is a
 * limit shared by four hundred people, so the fifth person to log dinner is
 * told to come back later because of what strangers did.
 *
 * Layer one therefore runs at onRequest keyed by IP, and layer two at
 * preHandler keyed by user id.
 */

import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { truncateIp } from '../services/auth.ts'

/**
 * Per-IP ceilings, by route.
 *
 * `/auth/request-code` is the one that spends money on a stranger's behalf. The
 * service already caps codes per phone number, but that alone lets a single
 * host walk the numbering plan — 120 requests a minute against 120 *different*
 * numbers is around 170,000 messages a day, every one of them billed to us and
 * delivered to somebody who did not ask for it. The per-IP cap is what makes
 * the per-phone cap meaningful.
 */
const IP_LIMITS: Record<string, { max: number; timeWindow: string }> = {
  'POST /auth/request-code': { max: 6, timeWindow: '1 hour' },
  // Guessing a six-digit code needs volume. The per-challenge attempt counter
  // is the real defence; this stops the search being parallelised across many
  // challenges from one host.
  'POST /auth/verify': { max: 20, timeWindow: '10 minutes' },
}

const DEFAULT_IP_LIMIT = { max: 120, timeWindow: '1 minute' }

/**
 * Routes that reach a model, and therefore cost money per call.
 *
 * Kept as an explicit list rather than inferred, so that adding a model call to
 * a route is a deliberate decision about who pays for it.
 */
export const MODEL_ROUTES: readonly string[] = [
  'POST /meals/draft',
  'POST /meals/draft-text',
  // Speech is billed per second of audio and accepts the largest body this API
  // takes, so leaving it off this list was the most expensive omission
  // available: a caller could spend without limit inside the generic per-IP
  // allowance.
  'POST /meals/transcribe',
  'POST /chat',
  'POST /users/me/ask',
  'POST /users/me/suggest',
  'POST /users/me/reports',
  'GET /users/me/day-line',
  'GET /users/me/weekly',
]

/**
 * Burst and daily ceilings per user.
 *
 * A person logs a handful of meals a day, so the burst allowance is generous
 * enough that no honest use ever meets it. The daily figure is not about
 * traffic shaping at all — it is the maximum a single compromised or automated
 * account can cost before somebody has to look at it.
 */
const MODEL_BURST = { max: 30, timeWindow: '1 minute' }
const MODEL_DAILY = { max: 400, timeWindow: '1 day' }

export interface LimitsOptions {
  /** Warn instead of staying silent when limits are per-process in production. */
  isProduction: boolean
}

function routeKey(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions?.url ?? request.url}`
}

/**
 * Layer one, applied as an instance-level onRequest hook.
 *
 * The plugin's own `global: true` mode was tried first and does not work here.
 * It attaches per-route hooks, and Fastify runs every instance-level onRequest
 * hook before any route-level one — so the auth plugin's 401 always won and
 * protected routes were never rate limited at all. The symptom was invisible
 * from the outside (a flood still got refused, just with a 401 after a database
 * round trip each time) which is precisely why it survived review and was only
 * caught by asking a running server.
 *
 * Registering the hook directly puts it in the one ordering Fastify guarantees:
 * instance-level hooks fire in registration order, and this plugin is
 * registered before the auth plugin.
 */
async function ipPlugin(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    // Nothing is limited by default; this registration exists to provide
    // createRateLimit, and every limiter below is applied explicitly.
    global: false,
  })

  /*
   * Built eagerly, one per distinct budget.
   *
   * Creating them inside the hook was tried and is wrong: each call to
   * createRateLimit allocates its own store, so a limiter made per request
   * counts every request as the first one and never limits anything.
   */
  const limiters = new Map<string, ReturnType<FastifyInstance['createRateLimit']>>()
  for (const [route, limit] of Object.entries(IP_LIMITS)) {
    limiters.set(
      route,
      app.createRateLimit({
        // Truncated to a /24 so one household or hostel floor is one bucket,
        // and a full address is never held for longer than the request.
        keyGenerator: (request) => `${route}:${truncateIp(request.ip)}`,
        max: limit.max,
        timeWindow: windowMs(limit.timeWindow),
      }),
    )
  }

  const fallback = app.createRateLimit({
    keyGenerator: (request) => `default:${truncateIp(request.ip)}`,
    max: DEFAULT_IP_LIMIT.max,
    timeWindow: windowMs(DEFAULT_IP_LIMIT.timeWindow),
  })

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const limiter = limiters.get(routeKey(request)) ?? fallback
    const result = await limiter(request)

    // `isAllowed` does not mean "under the limit" — the documentation defines
    // it as "excluded from rate limiting by the allowList". The exceeded flag
    // is the one that answers the question being asked here, and reading the
    // other as a verdict silently rejects every request from the first one on.
    if (result.isAllowed || !result.isExceeded) return

    reply.header('retry-after', String(result.ttlInSeconds))
    // Sent directly rather than thrown. An error would travel through the
    // server's error handler, and a limiter that depends on somebody else's
    // error handling to report the right status is one edit from reporting 500.
    return reply.status(429).send({
      error: 'rate_limited',
      message: 'Too many requests just now. Try again in a little while.',
    })
  })
}

/**
 * Layer two. Registered *after* the auth plugin, because it keys on the user
 * that hook resolved. A per-user limit that runs before authentication is a
 * per-IP limit wearing the wrong name.
 */
async function userPlugin(app: FastifyInstance, options: LimitsOptions): Promise<void> {
  const burst = app.createRateLimit({
    keyGenerator: (request) => `burst:${request.user?.id ?? truncateIp(request.ip)}`,
    max: MODEL_BURST.max,
    timeWindow: windowMs(MODEL_BURST.timeWindow),
  })

  const daily = app.createRateLimit({
    keyGenerator: (request) => `daily:${request.user?.id ?? truncateIp(request.ip)}`,
    max: MODEL_DAILY.max,
    timeWindow: windowMs(MODEL_DAILY.timeWindow),
  })

  const modelRoutes = new Set(MODEL_ROUTES)

  // preHandler rather than onRequest: request.user is populated by the auth
  // hook, and reading it any earlier would find nothing there.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!modelRoutes.has(routeKey(request))) return

    for (const limiter of [burst, daily]) {
      const result = await limiter(request)
      // Same reading as above: exceeded is the verdict, allowed is the bypass.
      if (!result.isAllowed && result.isExceeded) {
        request.log.warn(
          { userId: request.user?.id, route: routeKey(request) },
          'per-user model limit reached',
        )
        reply.header('retry-after', String(result.ttlInSeconds))
        return reply.status(429).send({
          error: 'rate_limited',
          message: "That's a lot of questions in a short time. Give it a moment.",
        })
      }
    }
  })

  // The default store is per-process. With more than one instance behind a load
  // balancer the effective limit multiplies by the instance count, so this is
  // said out loud at boot rather than discovered from a bill.
  if (options.isProduction) {
    app.log.warn(
      'Rate limits use the in-process store. Running more than one instance ' +
        'multiplies every limit by the instance count; configure a shared store ' +
        'before scaling out.',
    )
  }
}

/** Windows are written as text above because that is how they are reasoned about. */
function windowMs(window: string): number {
  const [amount, unit] = window.split(' ') as [string, string]
  const scale: Record<string, number> = {
    second: 1000,
    seconds: 1000,
    minute: 60 * 1000,
    minutes: 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  }
  const factor = scale[unit]
  if (!factor) throw new Error(`Unrecognised rate limit window: ${window}`)
  return Number(amount) * factor
}

export const ipLimitsPlugin = fp(ipPlugin, { name: 'ogt-ip-limits' })
export const userLimitsPlugin = fp(userPlugin, { name: 'ogt-user-limits' })
