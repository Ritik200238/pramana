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
import type { FastifyBaseLogger } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { ethers } from 'ethers'
import { sql } from 'drizzle-orm'
import {
  AnchorClient,
  CoachClient,
  NETWORKS,
  OGRouterError,
  OGStorage,
  assertAllChainsAreTeeAttested,
  chooseService,
  createBrokerClient,
  createClient,
  listChatServices,
} from '@ogt/og'
import type OpenAI from 'openai'
import { loadConfig } from './config.ts'
import { createDb, type Database } from './db/index.ts'
import { registerMealRoutes } from './routes/meals.ts'
import { registerChatRoutes } from './routes/chat.ts'
import { registerUserRoutes } from './routes/users.ts'
import { registerExportRoutes } from './routes/export.ts'
import { registerCustodyRoutes } from './routes/custody.ts'
import { registerDayRoutes } from './routes/day.ts'
import { registerCoachRoutes } from './routes/coach.ts'
import { startScheduler } from './jobs/scheduler.ts'
import { startAnchorWorker } from './jobs/anchor.ts'
import { startCoachWorker } from './jobs/coach-brain.ts'
import { postgresPassLock } from './jobs/pass-lock.ts'
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

/**
 * An OpenAI client that pays providers directly from the wallet.
 *
 * Discovery happens once at boot rather than per request: the marketplace is a
 * contract read, and doing it on the path a person is waiting on would add a
 * chain round trip to every meal.
 *
 * Refuses rather than falls back. A deployment that asked for the broker and
 * silently got the Router would be spending money in a way nobody chose, and
 * the operator would find out from a bill.
 */
async function buildBrokerClient(
  config: ReturnType<typeof loadConfig>,
  log: FastifyBaseLogger,
): Promise<OpenAI> {
  let broker: { inference: never }
  try {
    const { createZGComputeNetworkBroker } = await import('@0glabs/0g-serving-broker')
    const provider = new ethers.JsonRpcProvider(
      config.OG_RPC_URL_OVERRIDE ?? NETWORKS[config.OG_NETWORK].rpcUrl,
      NETWORKS[config.OG_NETWORK].chainId,
      { staticNetwork: true },
    )
    broker = (await createZGComputeNetworkBroker(
      new ethers.Wallet(config.OG_STORAGE_PRIVATE_KEY, provider) as never,
    )) as never
  } catch (error) {
    throw new Error(
      'OG_INFERENCE_MODE=broker needs @0glabs/0g-serving-broker installed. It is a ' +
        'devDependency because it carries 20 production advisories; installing it is the ' +
        'decision for whoever runs it. See VERIFICATION.md. ' +
        (error instanceof Error ? error.message : ''),
    )
  }

  const service = chooseService(await listChatServices(broker.inference))
  const { endpoint } = await getServiceMetadata(broker, service.provider)

  log.info(
    { provider: service.provider, model: service.model, tee: service.teeVerified },
    'inference is paid directly from the wallet, with no API key',
  )

  return createBrokerClient({
    broker: broker.inference,
    provider: service.provider,
    endpoint,
    // Carries the provider's own model chain, so no route has to know which
    // path this deployment took.
    service,
    // Unsettled fees accumulate until a provider stops answering, so a failure
    // here has to be visible rather than swallowed.
    onSettleError: (error) => log.error({ err: error }, 'settling an inference fee failed'),
  })
}

async function getServiceMetadata(
  broker: { inference: never },
  provider: string,
): Promise<{ endpoint: string; model: string }> {
  const inference = broker.inference as unknown as {
    getServiceMetadata: (p: string) => Promise<{ endpoint: string; model: string }>
  }
  return inference.getServiceMetadata(provider)
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
  /*
   * Whichever way this deployment reaches 0G Compute.
   *
   * The broker path pays providers directly from the wallet and needs no key
   * from anybody. It was built and verified live against the real marketplace
   * well before this line existed — which meant a working integration nothing
   * could select, the defect this repository keeps producing, committed here by
   * the person writing about it.
   *
   * The SDK is loaded on demand because it is a devDependency: it carries 20
   * production advisories, and a deployment that does not choose this path
   * should not carry them. An operator choosing it installs it deliberately.
   */
  const openai =
    overrides.openai ??
    (config.OG_INFERENCE_MODE === 'broker'
      ? await buildBrokerClient(config, app.log)
      : createClient({ apiKey: config.OG_ROUTER_API_KEY! }))
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

  /*
   * Readiness: should anything be sent here right now.
   *
   * Distinct from liveness on purpose. `/health` answering means the process is
   * alive and must not be killed; this answering means it can take work. During
   * a shutdown the first is true and the second is not, and conflating them
   * either kills a draining process early or keeps routing traffic into one
   * that is closing.
   */
  app.get('/ready', async (_request, reply) => {
    /*
     * Said before the drain begins, not during it.
     *
     * A load balancer stops sending work when this turns 503, and it only
     * notices on its next probe. Closing the socket first — which is what
     * happened before this existed — means every request in that window is
     * refused rather than answered, on every single deploy.
     */
    if (shuttingDown) {
      return reply.status(503).send({ ready: false, shuttingDown: true, checks: {} })
    }

    const checks: Record<string, 'ok' | 'failed'> = {}

    try {
      await db.execute(sql`select 1`)
      checks['database'] = 'ok'
    } catch {
      checks['database'] = 'failed'
    }

    const ready = Object.values(checks).every((value) => value === 'ok')
    return reply.status(ready ? 200 : 503).send({ ready, shuttingDown: false, checks })
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
  await registerMealRoutes(app, { db, openai, routerApiKey: config.OG_ROUTER_API_KEY ?? '' })
  await registerChatRoutes(app, { db, openai })
  await registerDayRoutes(app, { db })
  await registerCoachRoutes(app, { db, openai })
  await registerExportRoutes(app, {
    db,
    masterSeed: config.OG_ANCHOR_MASTER_SEED,
    /*
     * So an export can say whether our rows still agree with what was anchored.
     * Absent when anchoring is not configured, and the export says so rather
     * than reporting "verified" for a check nobody ran.
     */
    ...(config.OG_ANCHOR_ADDRESS
      ? {
          anchorClient: new AnchorClient({
            rpcUrl: config.OG_RPC_URL_OVERRIDE ?? NETWORKS[config.OG_NETWORK].rpcUrl,
            contractAddress: config.OG_ANCHOR_ADDRESS,
            relayerPrivateKey: config.OG_STORAGE_PRIVATE_KEY,
            chainId: NETWORKS[config.OG_NETWORK].chainId,
          }),
        }
      : {}),
  })
  await registerCustodyRoutes(app, {
    db,
    anchorAddress: config.OG_ANCHOR_ADDRESS,
    chainId: NETWORKS[config.OG_NETWORK].chainId,
  })

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

  /*
   * Cross-instance exclusion for the background passes.
   *
   * Only when this server owns its connection: an injected database is a test
   * or an embedded one, where there is no second instance to exclude and no
   * pool to reserve from. Without a lock the workers behave exactly as they
   * did, which is correct for one instance and only for one.
   */
  const passLock = owned ? postgresPassLock(owned.sql) : undefined

  // 0G Storage snapshots. Without this the encrypted user-owned record is a
  // claim rather than a mechanism — the code existed but nothing ran it.
  const scheduler = startScheduler({
    db,
    storage,
    masterSeed: config.OG_ANCHOR_MASTER_SEED,
    logger: app.log,
    lock: passLock,
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
          lock: passLock,
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
          lock: passLock,
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

/**
 * How long a shutdown may take before it stops being graceful.
 *
 * Long enough for a meal commit to finish — the slowest thing on a request
 * path is a model call, and those carry their own thirty-second timeout — and
 * short enough to stay inside the window an orchestrator allows before it sends
 * SIGKILL. Kubernetes defaults to thirty seconds.
 */
const SHUTDOWN_GRACE_MS = 25_000

/**
 * How long to keep answering after readiness turns 503.
 *
 * A load balancer only learns this process is going away on its next probe, and
 * requests it already routed are still arriving. Draining immediately would
 * refuse them. Kubernetes probes every ten seconds by default, so this is one
 * cycle plus a little — long enough to be noticed, short enough to leave most
 * of the grace window for the drain itself.
 */
const READINESS_DRAIN_MS = 12_000

/**
 * Whether a shutdown has begun.
 *
 * Module-level because `/ready` is registered once per server and the signal
 * arrives long afterwards; threading a flag through the route would mean the
 * route holding a reference to something that does not exist yet at
 * registration time.
 */
let shuttingDown = false

/** Exported for tests, which cannot send this process a real signal. */
export function beginShutdown(): void {
  shuttingDown = true
}

export function isShuttingDown(): boolean {
  return shuttingDown
}

/** Tests share a module instance; without this, one case leaks into the next. */
export function resetShutdownState(): void {
  shuttingDown = false
}

/**
 * Stop taking new work, let what is running finish, then close.
 *
 * There was no signal handling here at all, so every deploy killed the process
 * outright: requests in flight were dropped, `onClose` never ran, and the
 * connection pool was never drained.
 *
 * The chain was never at risk — an anchor carries a deterministic nonce the
 * contract refuses twice, and Postgres frees the advisory lock when the holder
 * dies — but somebody's meal commit vanished mid-request. The offline queue
 * retries with the same idempotency key, so nothing was lost permanently; it
 * looked to them like the app failed, which is its own kind of cost.
 */
export async function shutdown(
  app: Pick<Awaited<ReturnType<typeof buildServer>>['app'], 'close' | 'log'>,
  signal: string,
  /*
   * Injected so a test can watch what happens without ending its own process.
   * The alternative is asserting against the source, which this session has
   * repeatedly shown can be satisfied without the behaviour being there.
   */
  exit: (code: number) => void = (code) => process.exit(code),
  /** Shortened in tests, which should not wait twelve seconds to prove a flag. */
  drainDelayMs: number = READINESS_DRAIN_MS,
): Promise<void> {
  /*
   * Readiness first, then a pause, then the drain.
   *
   * Turning 503 is what tells a load balancer to stop, and it only finds out on
   * its next probe — so closing straight away refuses everything already in
   * flight toward us. That is the difference between a deploy nobody notices
   * and one that produces a burst of errors every time.
   */
  beginShutdown()
  app.log.info({ signal }, 'shutting down; refusing readiness, finishing what is in flight')

  await new Promise((resolve) => setTimeout(resolve, drainDelayMs))

  const forced = setTimeout(() => {
    // A request that will not finish must not hold the deploy open until the
    // orchestrator loses patience and sends SIGKILL, which drops everything
    // else with it.
    app.log.error({ signal }, 'shutdown took too long; exiting anyway')
    exit(1)
  }, SHUTDOWN_GRACE_MS)

  // Does not keep the process alive on its own account.
  forced.unref()

  try {
    // Runs the onClose hook: workers stopped, pool drained.
    await app.close()
    app.log.info('shut down cleanly')
    exit(0)
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed')
    exit(1)
  }
}

if (isEntrypoint) {
  const { app, config } = await buildServer()

  /*
   * SIGTERM is what an orchestrator sends on a deploy; SIGINT is Ctrl-C. Both
   * mean the same thing here, and both were previously unhandled.
   *
   * `once` rather than `on`: a second signal while a shutdown is already
   * running is somebody being impatient, and starting a second one would race
   * the first.
   */
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(app, signal)
    })
  }

  try {
    await app.listen({ port: config.PORT, host: config.HOST })
  } catch (error) {
    app.log.error({ err: error }, 'failed to start')
    process.exit(1)
  }
}
