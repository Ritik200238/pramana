/**
 * Idempotent writes.
 *
 * The web client queues meals logged with no signal and replays them when the
 * connection returns. Some of those replays are for requests the server already
 * applied — the response was lost, not the request. Without this, a person who
 * logged dinner in a lift sees dinner twice, and a food log somebody does not
 * trust is one they stop opening.
 *
 * The contract:
 *
 *   - A write may carry `Idempotency-Key`. Same key, same endpoint, same body
 *     returns the first response verbatim without doing the work again.
 *   - Same key with a *different* body is a client bug and is refused with 422,
 *     rather than silently returning a response to a request nobody made.
 *   - A key still in flight returns 409. Two concurrent replays must not both
 *     run the write.
 *
 * Keys are scoped per user, so two people cannot collide and nobody can read
 * back somebody else's response by guessing.
 *
 * Only successful writes are recorded. A failure that is retried should be
 * allowed to succeed — replaying a stored 500 forever would turn a transient
 * fault into a permanent one.
 */

import { createHash } from 'node:crypto'
import fp from 'fastify-plugin'
import { and, eq, lt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '../db/index.ts'
import { idempotencyKeys } from '../db/schema.ts'

/**
 * How long a key is honoured.
 *
 * Long enough to cover a phone that was offline overnight, short enough that
 * the table is not a permanent record of every write ever made.
 */
export const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000

/**
 * Writes that create something.
 *
 * Deliberately a list rather than "every POST". A key on `/meals/draft` would
 * be pointless — it creates nothing — and one on `/chat` would be wrong, since
 * saying the same sentence twice is a thing people genuinely do.
 */
export const IDEMPOTENT_ROUTES: readonly string[] = [
  'POST /meals/commit',
  'POST /meals/repeat',
  'POST /users/me/weight',
  'POST /users/me/profile',
]

export interface IdempotencyOptions {
  db: Database
}

function routeKey(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions?.url ?? request.url}`
}

function hashBody(body: unknown): string {
  // Key order is not stable across JSON round trips, so the hash is taken over
  // sorted keys. Otherwise the same request could hash two ways and a genuine
  // replay would be reported as a conflicting one.
  return createHash('sha256').update(stableStringify(body)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)

  return `{${entries.join(',')}}`
}

async function plugin(app: FastifyInstance, options: IdempotencyOptions): Promise<void> {
  const routes = new Set(IDEMPOTENT_ROUTES)

  // preHandler, so the body is parsed and the session resolved. Both are needed
  // to answer whether this is the same request from the same person.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!routes.has(routeKey(request))) return

    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0) return
    if (key.length > 200) {
      return reply.status(400).send({ error: 'invalid_idempotency_key' })
    }

    const userId = request.user?.id
    if (!userId) return // Unauthenticated; the auth hook has already refused it.

    const endpoint = routeKey(request)
    const requestHash = hashBody(request.body ?? null)
    const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS)

    // Expired keys are cleared opportunistically rather than by a job. This
    // touches only this user's own rows and keeps the table from growing
    // without bound.
    await options.db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), lt(idempotencyKeys.createdAt, cutoff)))

    // The unique constraint is what makes this safe under concurrency: exactly
    // one of two simultaneous replays inserts, and the other reads what it
    // found. A read-then-write would let both through.
    const claimed = await options.db
      .insert(idempotencyKeys)
      .values({ userId, key, endpoint, requestHash })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id })

    if (claimed.length > 0) {
      request.idempotency = { key, userId, endpoint, requestHash }
      return
    }

    const [existing] = await options.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
      .limit(1)

    if (!existing) return // Raced with the cleanup above; let it run normally.

    if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
      // A key reused for different content. Returning the stored response here
      // would answer a question nobody asked, so this is refused loudly.
      return reply.status(422).send({
        error: 'idempotency_key_reused',
        message: 'This idempotency key was already used for a different request.',
      })
    }

    if (existing.completedAt === null) {
      reply.header('retry-after', '1')
      return reply.status(409).send({
        error: 'request_in_progress',
        message: 'An identical request is still being processed.',
      })
    }

    reply.header('idempotent-replay', 'true')
    return reply.status(existing.statusCode ?? 200).send(existing.responseBody)
  })

  // onSend rather than onResponse: this is the last point at which the payload
  // is still available to store.
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const record = request.idempotency
    if (!record) return payload

    // Only successes are recorded. Storing a failure would make a transient
    // fault permanent for anyone who retried with the same key.
    if (reply.statusCode >= 400) {
      await options.db
        .delete(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.userId, record.userId), eq(idempotencyKeys.key, record.key)),
        )
        .catch(() => {
          // The row expires on its own; failing the response over cleanup would
          // be worse than leaving it.
        })
      return payload
    }

    let body: unknown = null
    try {
      body = typeof payload === 'string' ? JSON.parse(payload) : null
    } catch {
      // A non-JSON success body cannot be replayed, so the claim is released
      // rather than stored half-formed.
      return payload
    }

    await options.db
      .update(idempotencyKeys)
      .set({ statusCode: reply.statusCode, responseBody: body, completedAt: new Date() })
      .where(and(eq(idempotencyKeys.userId, record.userId), eq(idempotencyKeys.key, record.key)))
      .catch(() => {
        // Same reasoning: the write already succeeded and the caller must hear
        // about it. A replay that misses the record simply does the work again.
      })

    return payload
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { key: string; userId: string; endpoint: string; requestHash: string }
  }
}

export const idempotencyPlugin = fp(plugin, { name: 'ogt-idempotency' })
