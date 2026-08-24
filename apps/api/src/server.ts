/**
 * API server.
 *
 * Boot order matters: configuration is validated, then the TEE invariant on the
 * model chains is asserted, and only then do we listen. A health product that
 * comes up with a misconfigured model chain would be routing identified data to
 * an unattested model while appearing healthy.
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { assertAllChainsAreTeeAttested, createClient, NETWORKS, OGStorage } from '@ogt/og'
import { loadConfig } from './config.ts'
import { createDb } from './db/index.ts'
import { registerMealRoutes } from './routes/meals.ts'
import { registerChatRoutes } from './routes/chat.ts'
import { registerUserRoutes } from './routes/users.ts'
import { registerExportRoutes } from './routes/export.ts'
import { registerDayRoutes } from './routes/day.ts'
import { registerCoachRoutes } from './routes/coach.ts'
import { startScheduler } from './jobs/scheduler.ts'
import { authPlugin } from './plugins/auth.ts'
import { registerAuthRoutes } from './routes/auth.ts'

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

export async function buildServer() {
  const config = loadConfig()

  // Fail at boot, not on the first photo.
  assertAllChainsAreTeeAttested()

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      // Never log request bodies. They contain what people say about their
      // health, and a log file is the easiest place for that to leak.
      redact: ['req.headers.authorization', 'req.body', 'res.body'],
    },
    bodyLimit: config.MAX_PHOTO_BYTES,
  })

  await app.register(cors, { origin: [...config.corsOrigins], credentials: true })
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })
  await app.register(multipart, { limits: { fileSize: config.MAX_PHOTO_BYTES } })

  const { db, close } = createDb(config.DATABASE_URL)

  // Registered before any route: identity is resolved from a session on every
  // request, and is never read from a body, query, or path.
  await app.register(authPlugin, { db, publicRoutes: [...PUBLIC_ROUTES] })
  const openai = createClient({ apiKey: config.OG_ROUTER_API_KEY })
  const storage = new OGStorage({
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

  await registerAuthRoutes(app, {
    db,
    isDevelopment: config.NODE_ENV === 'development',
    secureCookies: config.NODE_ENV === 'production',
  })
  await registerUserRoutes(app, { db })
  await registerMealRoutes(app, { db, openai })
  await registerChatRoutes(app, { db, openai })
  await registerDayRoutes(app, { db })
  await registerCoachRoutes(app, { db, openai })
  await registerExportRoutes(app, { db })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        detail: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    request.log.error({ err: error }, 'unhandled error')

    // Never leak an internal message to a client. It can contain a connection
    // string, a key fragment, or a fragment of someone else's data.
    return reply.status(500).send({ error: 'internal_error' })
  })

  // 0G Storage snapshots. Without this the encrypted user-owned record is a
  // claim rather than a mechanism — the code existed but nothing ran it.
  const scheduler = startScheduler({ db, storage, logger: app.log })

  app.addHook('onClose', async () => {
    scheduler.stop()
    await close()
  })

  // Lets a deploy or an operator force a pass without waiting for the timer.
  app.post('/admin/run-snapshots', async (request, reply) => {
    const result = await scheduler.runOnce()
    request.log.info(result, 'manual snapshot pass')
    return reply.status(200).send(result)
  })

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
