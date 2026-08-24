/**
 * End-to-end harness.
 *
 * Everything here is the real thing except the two dependencies that cost money
 * to touch:
 *
 *   real  — PostgreSQL 18 (PGlite is Postgres compiled to WebAssembly, not an
 *           emulation), the actual migrations, the actual Fastify instance, the
 *           actual auth plugin, the actual rate limiters, the actual routes.
 *   fake  — the model client and 0G Storage.
 *
 * That split is deliberate. The questions this suite answers are about the
 * journey — can a person sign in, does the session hold, does identity stay
 * theirs, does a constraint fire — and every one of those is a property of the
 * database and the HTTP stack. Whether the model reads a plate of rice
 * correctly is a different question that a stub could only ever answer falsely;
 * it belongs in the live Router benchmark, not here.
 *
 * The previous suite tested handlers in isolation and could not have caught the
 * two defects found this week: a route registered outside the auth allowlist,
 * and an onboarding path that wrote a user nobody could sign in to. Both are
 * wiring, and wiring is only visible from the outside.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { FastifyInstance } from 'fastify'
import * as schema from '../../src/db/schema.ts'
import type { Database } from '../../src/db/index.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS = join(HERE, '..', '..', 'drizzle')

/** Env the config validator demands. None of it is reached by these tests. */
const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://unused:5432/unused',
  OG_ROUTER_API_KEY: 'sk-test-not-a-real-key',
  OG_STORAGE_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  OG_NETWORK: 'testnet',
  ADMIN_TOKEN: 'test-admin-token-that-is-long-enough-to-pass',
  // Present so the derived-key paths are exercised rather than skipped. Without
  // it, record keys are never created and half the 0G surface stays inert in
  // tests while looking fine — which is how the real thing went unnoticed.
  OG_ANCHOR_MASTER_SEED: 'a-test-master-seed-long-enough-to-be-accepted',
} as const

export interface Harness {
  app: FastifyInstance
  db: Database
  /** What the fake model was asked to do, in order. */
  modelCalls: Array<{ model: string; messages: unknown }>
  /** Codes handed to the sender. Proves delivery was attempted, not just stored. */
  sentCodes: Array<{ to: string; code: string }>
  /** Set to make the next send fail, as an outage would. */
  failNextSend: (fail: boolean) => void
  adminToken: string
  close: () => Promise<void>
}

/**
 * Apply the real migration files in order.
 *
 * Drizzle's own migrator is skipped because it records state in a table keyed
 * to the driver; running the SQL directly is both simpler and a stricter test —
 * if a migration is not valid Postgres, this fails here rather than in
 * production.
 */
async function migrate(client: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    // Drizzle separates statements with this marker rather than a bare
    // semicolon, because a semicolon can appear inside a function body.
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.exec(trimmed)
    }
  }
}

/** A model client shaped like the one the routes use, answering canned JSON. */
function fakeModel(record: Harness['modelCalls']) {
  return {
    chat: {
      completions: {
        async create(body: { model: string; messages: unknown }) {
          record.push({ model: body.model, messages: body.messages })
          return {
            id: 'chatcmpl-test',
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }
        },
      },
    },
  }
}

export async function startHarness(): Promise<Harness> {
  for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value

  const client = await PGlite.create()
  await migrate(client)

  // Both sides are genuine drizzle instances over the same schema; only the
  // driver underneath differs, which is exactly what makes this a useful test.
  const db = drizzle(client, { schema }) as unknown as Database

  const modelCalls: Harness['modelCalls'] = []
  const sentCodes: Harness['sentCodes'] = []
  let failSend = false

  // A recording sender rather than the console one, so tests can assert the
  // code was actually handed to something that would deliver it.
  const sender = {
    name: 'recording',
    async send(message: { to: string; code: string }) {
      if (failSend) throw new Error('provider is down')
      sentCodes.push({ to: message.to, code: message.code })
    },
  }

  // Imported here rather than at module scope so the env above is in place
  // before the config validator reads it.
  const { buildServer } = await import('../../src/server.ts')

  const { app } = await buildServer({
    db,
    openai: fakeModel(modelCalls) as never,
    storage: { signerAddress: '0x' + '22'.repeat(20) } as never,
    sender,
    backgroundJobs: false,
    quiet: true,
  })

  await app.ready()

  return {
    app,
    db,
    modelCalls,
    sentCodes,
    failNextSend: (fail: boolean) => {
      failSend = fail
    },
    adminToken: TEST_ENV.ADMIN_TOKEN,
    close: async () => {
      await app.close()
      await client.close()
    },
  }
}

/**
 * Sign in the way the app does, and hand back the bearer token.
 *
 * Deliberately drives the real endpoints rather than inserting a session row.
 * A helper that forges its own session would make every test that depends on it
 * blind to a break in the thing users actually do first.
 */
export async function signIn(
  harness: Harness,
  phone: string,
): Promise<{ token: string; isNewUser: boolean }> {
  const requested = await harness.app.inject({
    method: 'POST',
    url: '/auth/request-code',
    payload: { phone },
  })
  if (requested.statusCode !== 200) {
    throw new Error(`request-code failed: ${requested.statusCode} ${requested.body}`)
  }

  const { devCode } = requested.json() as { devCode?: string }
  if (!devCode) throw new Error('development builds must expose the code for tests')

  const verified = await harness.app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { phone, code: devCode },
  })
  if (verified.statusCode !== 200) {
    throw new Error(`verify failed: ${verified.statusCode} ${verified.body}`)
  }

  const body = verified.json() as { token: string; isNewUser: boolean }
  return body
}

/** A complete, valid onboarding body. */
export const VALID_PROFILE = {
  sex: 'male',
  ageYears: 25,
  heightCm: 175,
  weightKg: 72,
  activity: 'light',
  goal: 'lose',
  diet: 'veg',
  cooks: 'mess',
} as const
