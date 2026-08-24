/**
 * API server.
 *
 * Boot order matters: configuration is validated, then the TEE invariant on the
 * model chains is asserted, and only then do we listen. A health product that
 * comes up with a misconfigured model chain would be routing identified data to
 * an unattested model while appearing healthy.
 */

import { timingSafeEqual } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import {
  AnchorClient,
  OGRouterError,
  CoachClient,
  assertAllChainsAreTeeAttested,
  createClient,
  NETWORKS,
  OGStorage,
} from '@ogt/og'
import type OpenAI from 'openai'
import { loadConfig } from './config.ts'
import { createDb, type Database } from './db/index.ts'
import { registerMealRoutes } from './routes/meals.ts'
import { registerChatRoutes } from './routes/chat.ts'
import { registerUserRoutes } from './routes/users.ts'
import { registerExportRoutes } from './routes/export.ts'
import { registerDayRoutes } from './routes/day.ts'
import { registerCoachRoutes } from './routes/coach.ts'
import { startScheduler } from './jobs/scheduler.ts'
import { startAnchorWorker } from './jobs/anchor.ts'
import { startCoachWorker } from './jobs/coach-brain.ts'
import { startBalanceWatch } from './jobs/balance.ts'
import { authPlugin } from './plugins/auth.ts'
import { idempotencyPlugin } from './plugins/idempotency.ts'
import { ipLimitsPlugin, userLimitsPlugin } from './plugins/limits.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { createSmsSender, type SmsSender } from './services/sms.ts'

/**
 * Routes reachable without a session.
 *
 * Deliberately a short, explicit allowlist rather than a decorator on each
 * protected route: a new endpoint is protected by default, and exposing one
 * has to be a conscious edit to this list. The opposite default means a single
 * forgotten annotation silently publishes a health record.
 */
const PUBLIC_ROUTES = [
  'GET /health',
  'GET /ready',
  'POST /auth/request-code',
  'POST /auth/verify',
  'POST /auth/signout',
] as const

/**
 * Exempt from the session hook, but emphatically not unauthenticated.
 *
 * An operator is not a user and has no session to present, so these carry their
 * own stronger check: a shared secret compared in constant time. They are kept
 * in a separate list so PUBLIC_ROUTES can still be read as "anyone may call
 * this" — collapsing the two would make the more dangerous list look like the
 * safer one.
 */
const OPERATOR_ROUTES = ['POST /admin/run-snapshots'] as const

/**
 * Dependencies a test may supply instead of the real thing.
 *
 * Production passes nothing and every field is constructed normally. This
 * exists so an end-to-end test can drive the real Fastify stack, the real auth
 * plugin and a real Postgres, without reaching a paid model or a live chain —
 * and so that the thing under test is the actual server rather than a
 * rehearsal of it assembled by the test.
 */
export interface ServerOverrides {
  db?: Database
  openai?: OpenAI
  storage?: OGStorage
  sender?: SmsSender
  /** Background snapshotting. Off in tests so a timer cannot outlive a case. */
  backgroundJobs?: boolean
  /** Silences the logger so a test run's output is its assertions. */
  quiet?: boolean
}

export async function buildServer(overrides: ServerOverrides = {}) {
  const config = loadConfig()

  // Fail at boot, not on the first photo.
  assertAllChainsAreTeeAttested()

  const app = Fastify({
    logger: {
      level: overrides.quiet
        ? 'silent'
        : config.NODE_ENV === 'production'
          ? 'info'
          : 'debug',
      // Never log request bodies. They contain what people say about their
      // health, and a log file is the easiest place for that to leak.
      redact: ['req.headers.authorization', 'req.body', 'res.body'],
    },
    bodyLimit: config.MAX_PHOTO_BYTES,
  })

  await app.register(cors, { origin: [...config.corsOrigins], credentials: true })
  await app.register(multipart, { limits: { fileSize: config.MAX_PHOTO_BYTES } })

  // Before auth on purpose: a flood must be turned away without first costing
  // us a session lookup per request.
  await app.register(ipLimitsPlugin)

  // An injected database is owned by whoever injected it, so closing it here
  // would tear down a fixture still in use by the next assertion.
  const owned = overrides.db ? null : createDb(config.DATABASE_URL)
  const db = overrides.db ?? owned!.db
  const close = owned ? owned.close : async () => {}

  // Registered before any route: identity is resolved from a session on every
  // request, and is never read from a body, query, or path.
  await app.register(authPlugin, {
    db,
    publicRoutes: [...PUBLIC_ROUTES, ...OPERATOR_ROUTES],
  })

  // After auth, because this layer keys on the session that hook resolved.
  await app.register(userLimitsPlugin, {
    isProduction: config.NODE_ENV === 'production',
  })

  // After the limiter, so a replayed write cannot be used to spend past it.
  await app.register(idempotencyPlugin, { db })
  const openai = overrides.openai ?? createClient({ apiKey: config.OG_ROUTER_API_KEY })
  const storage =
    overrides.storage ??
    new OGStorage({
      network: NETWORKS[config.OG_NETWORK],
      signerPrivateKey: config.OG_STORAGE_PRIVATE_KEY,
      ...(config.OG_RPC_URL_OVERRIDE ? { rpcUrlOverride: config.OG_RPC_URL_OVERRIDE } : {}),
    })

  // Liveness: is the process up. Cheap, and must never touch a dependency —
  // an orchestrator restarting us because Postgres blinked makes an outage worse.
  app.get('/health', async () => ({
    ok: true,
    network: config.OG_NETWORK,
    chainId: NETWORKS[config.OG_NETWORK].chainId,
    storageSigner: storage.signerAddress,
  }))

  // Readiness: can we actually serve. Checks the dependencies we cannot work
  // without, and reports degraded rather than lying about being healthy.
  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'failed'> = {}

    try {
      await db.execute(sql`select 1`)
      checks['database'] = 'ok'
    } catch {
      checks['database'] = 'failed'
    }

    const ready = Object.values(checks).every((value) => value === 'ok')
    return reply.status(ready ? 200 : 503).send({ ready, checks })
  })

  // Constructed here rather than lazily: a production deployment with no
  // provider must fail at boot, not on the first person who tries to sign in.
  const sender =
    overrides.sender ??
    createSmsSender({
      isProduction: config.NODE_ENV === 'production',
      url: config.SMS_PROVIDER_URL,
      headers: config.SMS_PROVIDER_HEADERS,
      body: config.SMS_PROVIDER_BODY,
      log: (message) => app.log.info(message),
    })

  await registerAuthRoutes(app, {
    db,
    sender,
    isDevelopment: config.NODE_ENV === 'development',
    secureCookies: config.NODE_ENV === 'production',
  })
  await registerUserRoutes(app, { db })
  await registerMealRoutes(app, { db, openai, routerApiKey: config.OG_ROUTER_API_KEY })
  await registerChatRoutes(app, { db, openai })
  await registerDayRoutes(app, { db })
  await registerCoachRoutes(app, { db, openai })
  await registerExportRoutes(app, { db, masterSeed: config.OG_ANCHOR_MASTER_SEED })

  app.setErrorHandler((error, request, reply) => {
    /*
     * An upstream rate limit is not a server fault.
     *
     * Without this it fell through to the 500 branch, so a throttled account
     * looked like a broken product: the client would retry a queued meal
     * against a limit that was still in force, and the person would be told
     * something went wrong on our side when nothing had.
     *
     * The Router names the interval to wait; it is passed straight through
     * rather than replaced with a guess.
     */
    if (error instanceof OGRouterError && error.retryAfterSeconds !== null) {
      reply.header('retry-after', String(error.retryAfterSeconds))
      return reply.status(429).send({
        error: 'rate_limited',
        message: 'The coach is busy just now. Try again in a moment.',
      })
    }

    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        detail: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    /*
     * A client error keeps its own status.
     *
     * Collapsing everything into 500 was wrong in a way that is invisible
     * until you look at the wire: a rate-limited caller, a photo over the size
     * limit and a malformed request all reported a server fault. That tells
     * the client to retry something that will never succeed, tells the person
     * we broke when they did, and buries every genuine 500 in a graph of
     * things that were nobody's fault but the caller's.
     *
     * These are safe to name because of where they come from — Fastify's own
     * validation, the rate limiter, or an AuthError — none of which carry
     * internal detail in their message.
     */
    const status = (error as { statusCode?: number }).statusCode ?? 500

    if (status >= 400 && status < 500) {
      request.log.info({ err: error, status }, 'client error')
      return reply.status(status).send({
        error: (error as { code?: string }).code ?? 'bad_request',
        message: (error as { message?: string }).message ?? 'Bad request',
      })
    }

    request.log.error({ err: error }, 'unhandled error')

    // A server fault keeps nothing. The message can contain a connection
    // string, a key fragment, or a fragment of someone else's data.
    return reply.status(500).send({ error: 'internal_error' })
  })

  // 0G Storage snapshots. Without this the encrypted user-owned record is a
  // claim rather than a mechanism — the code existed but nothing ran it.
  const scheduler = startScheduler({
    db,
    storage,
    masterSeed: config.OG_ANCHOR_MASTER_SEED,
    logger: app.log,
  })
  if (overrides.backgroundJobs === false) scheduler.stop()

  /*
   * On-chain anchoring.
   *
   * Both the address and the seed are required, and the absence of either is
   * reported rather than passed over. Anchoring is what turns "the user owns
   * the pointer" from a claim about our database into a property of a public
   * chain, so running without it should be a decision somebody made, not one
   * they drifted into.
   */
  const anchorWorker =
    config.OG_ANCHOR_ADDRESS && config.OG_ANCHOR_MASTER_SEED
      ? startAnchorWorker({
          db,
          client: new AnchorClient({
            rpcUrl: config.OG_RPC_URL_OVERRIDE ?? NETWORKS[config.OG_NETWORK].rpcUrl,
            contractAddress: config.OG_ANCHOR_ADDRESS,
            relayerPrivateKey: config.OG_STORAGE_PRIVATE_KEY,
            chainId: NETWORKS[config.OG_NETWORK].chainId,
          }),
          masterSeed: config.OG_ANCHOR_MASTER_SEED,
          logger: app.log,
        })
      : null

  if (overrides.backgroundJobs === false) anchorWorker?.stop()

  /*
   * The coach as an owned asset.
   *
   * Without this the CoachAgent contract has no call sites at all, and the
   * ownership half of the 0G binding does no work: the coach would be a row in
   * our database that we describe as theirs.
   */
  const coachWorker =
    config.OG_COACH_ADDRESS && config.OG_ANCHOR_MASTER_SEED
      ? startCoachWorker({
          db,
          storage,
          client: new CoachClient({
            rpcUrl: config.OG_RPC_URL_OVERRIDE ?? NETWORKS[config.OG_NETWORK].rpcUrl,
            contractAddress: config.OG_COACH_ADDRESS,
            relayerPrivateKey: config.OG_STORAGE_PRIVATE_KEY,
            chainId: NETWORKS[config.OG_NETWORK].chainId,
          }),
          masterSeed: config.OG_ANCHOR_MASTER_SEED,
          logger: app.log,
        })
      : null

  if (overrides.backgroundJobs === false) coachWorker?.stop()

  /*
   * The balance that keeps everything working.
   *
   * Preflight checks it at deploy, but a balance drains while the server runs,
   * so it is worth watching. Warns only — topping up has money attached and
   * belongs to a person.
   */
  const balanceWatch = config.OG_ROUTER_MANAGEMENT_KEY
    ? startBalanceWatch({
        db,
        managementKey: config.OG_ROUTER_MANAGEMENT_KEY,
        logger: app.log,
      })
    : null

  if (overrides.backgroundJobs === false) balanceWatch?.stop()
  if (!balanceWatch) {
    app.log.warn(
      'No OG_ROUTER_MANAGEMENT_KEY: the balance cannot be read, so nothing will warn ' +
        'before inference starts failing with 402.',
    )
  }
  if (!anchorWorker) {
    app.log.warn(
      'On-chain anchoring is off: set OG_ANCHOR_ADDRESS and OG_ANCHOR_MASTER_SEED. ' +
        'Snapshots will be written to 0G Storage with their pointers held only here.',
    )
  }

  app.addHook('onClose', async () => {
    scheduler.stop()
    anchorWorker?.stop()
    coachWorker?.stop()
    balanceWatch?.stop()
    await close()
  })

  /**
   * Lets a deploy or an operator force a snapshot pass without waiting for the
   * timer.
   *
   * A session is not sufficient authorisation here and never was. This runs
   * across every user in the batch, writing to 0G Storage and paying gas for
   * each — so any signed-in account could turn one cheap request into unbounded
   * spend on everyone else's behalf. It now needs an operator secret, compared
   * in constant time, and is not mounted at all when none is configured.
   */
  if (config.ADMIN_TOKEN) {
    const expected = Buffer.from(config.ADMIN_TOKEN)

    app.post('/admin/run-snapshots', async (request, reply) => {
      const presented = Buffer.from(
        (request.headers['x-admin-token'] as string | undefined) ?? '',
      )

      // Length is checked first because timingSafeEqual throws on a mismatch,
      // and the length of an operator secret is not a useful thing to leak.
      const authorised =
        presented.length === expected.length && timingSafeEqual(presented, expected)

      if (!authorised) {
        request.log.warn(
          { ip: request.ip },
          'rejected an unauthorised attempt to force a snapshot pass',
        )
        return reply.status(404).send({ error: 'not_found' })
      }

      const snapshotResult = await scheduler.runOnce()
      // Anchoring follows snapshotting, so a forced pass produces a complete
      // record rather than one waiting on the next timer to reach the chain.
      const anchorResult = (await anchorWorker?.runOnce()) ?? null
      const coachResult = (await coachWorker?.runOnce()) ?? null
      request.log.info({ snapshotResult, anchorResult, coachResult }, 'manual snapshot pass')
      return reply
        .status(200)
        .send({ snapshots: snapshotResult, anchors: anchorResult, coaches: coachResult })
    })
  }

  return { app, config }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (isEntrypoint) {
  const { app, config } = await buildServer()
  try {
    await app.listen({ port: config.PORT, host: config.HOST })
  } catch (error) {
    app.log.error({ err: error }, 'failed to start')
    process.exit(1)
  }
}
