/**
 * Authentication plugin.
 *
 * The design rule that matters, and the reason this exists at all:
 *
 *   **A user id is never read from a request body, query, or path.**
 *
 * Before this, sixteen routes took `userId` from the client. That is not a
 * missing feature — it means anyone who can guess a UUID can read a stranger's
 * medical history, their chat, and their lab results. Deriving identity from a
 * session is the only version of this that is safe to run.
 *
 * `requireAuth` is opt-out rather than opt-in. A new route is protected by
 * default and has to be deliberately listed as public — the alternative is that
 * one forgotten decorator silently exposes a health record.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { Database } from '../db/index.ts'
import { resolveSession, type AuthenticatedUser } from '../services/auth.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook. Absent on public routes only. */
    user?: AuthenticatedUser
  }
}

export interface AuthPluginOptions {
  db: Database
  /** Routes reachable without a session. Everything else requires one. */
  publicRoutes: readonly string[]
}

/** Bearer token, or the session cookie if the client prefers that. */
function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()

  const cookie = request.headers.cookie
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === 'ogt_session') return decodeURIComponent(rest.join('='))
    }
  }

  return null
}

function isPublic(routePath: string, method: string, publicRoutes: readonly string[]): boolean {
  return publicRoutes.includes(`${method} ${routePath}`) || publicRoutes.includes(routePath)
}

async function plugin(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  app.decorateRequest('user', undefined)

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // routeOptions.url is the registered pattern, not the concrete path, so a
    // route cannot be made public by crafting a URL that happens to match.
    const pattern = request.routeOptions?.url ?? request.url

    if (isPublic(pattern, request.method, options.publicRoutes)) return

    const token = extractToken(request)
    if (!token) {
      return reply.status(401).send({ error: 'unauthenticated' })
    }

    const user = await resolveSession(options.db, token)
    if (!user) {
      // Expired, revoked, and never-existed are all reported identically.
      // Distinguishing them tells an attacker which tokens are worth retrying.
      return reply.status(401).send({ error: 'unauthenticated' })
    }

    request.user = user
  })
}

export const authPlugin = fp(plugin, { name: 'ogt-auth' })

/**
 * The authenticated user id.
 *
 * Every handler uses this instead of reading an id from input. If the hook did
 * not run, this throws rather than falling back to anything — a route that
 * reaches here without a session is a bug in the plugin wiring, and failing
 * loudly is far better than serving someone else's data.
 */
export function currentUserId(request: FastifyRequest): string {
  if (!request.user) {
    throw new Error(
      'currentUserId() called on a route with no authenticated user. Either the route is ' +
        'missing from publicRoutes, or the auth plugin is not registered.',
    )
  }
  return request.user.id
}
