/**
 * Sign-in.
 *
 * Phone plus a one-time code. No password to forget, no wallet to lose, and no
 * email a shared family phone might not have.
 *
 * Two behaviours here are security properties rather than UX choices:
 *
 *   - Requesting a code returns the same response whether or not the number is
 *     registered. Otherwise this endpoint answers "does this person use a
 *     health app", which is not ours to disclose.
 *   - Verification failures are all reported identically. Distinguishing wrong
 *     from expired from used tells an attacker which codes are worth retrying.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { sessions, users } from '../db/schema.ts'
import {
  AuthError,
  requestCode,
  revokeAllSessions,
  revokeSession,
  verifyCode,
} from '../services/auth.ts'
import { currentUserId } from '../plugins/auth.ts'

export interface AuthRouteDeps {
  db: Database
  isDevelopment: boolean
  /** Secure cookies require HTTPS, so this follows the deployment. */
  secureCookies: boolean
}

const PhoneBody = z.object({ phone: z.string().min(6).max(20) })
const VerifyBody = z.object({
  phone: z.string().min(6).max(20),
  code: z.string().regex(/^\d{4,8}$/, 'A code is digits only.'),
})

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  /** Send a one-time code. Enumeration-resistant by construction. */
  app.post('/auth/request-code', async (request, reply) => {
    const body = PhoneBody.parse(request.body)

    try {
      const result = await requestCode({
        db: deps.db,
        phone: body.phone,
        // Only in development, and gated on the server's own config rather
        // than anything the client can ask for.
        exposeCodeForDevelopment: deps.isDevelopment,
      })
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.status(error.status).send({ error: error.code, message: error.message })
      }
      throw error
    }
  })

  /** Exchange a code for a session. Creates the account on first sign-in. */
  app.post('/auth/verify', async (request, reply) => {
    const body = VerifyBody.parse(request.body)

    try {
      const session = await verifyCode({
        db: deps.db,
        phone: body.phone,
        code: body.code,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      })

      // httpOnly so script on the page cannot read it; sameSite=lax so a
      // cross-site form post cannot ride it.
      reply.header(
        'Set-Cookie',
        [
          `ogt_session=${encodeURIComponent(session.token)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)}`,
          ...(deps.secureCookies ? ['Secure'] : []),
        ].join('; '),
      )

      return reply.status(200).send({
        // Also returned in the body for non-browser clients.
        token: session.token,
        expiresAt: session.expiresAt,
        isNewUser: session.isNewUser,
      })
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.status(error.status).send({ error: error.code, message: error.message })
      }
      throw error
    }
  })

  /** Who am I, and is onboarding finished? */
  app.get('/auth/me', async (request, reply) => {
    const userId = currentUserId(request)

    const [user] = await deps.db
      .select({
        id: users.id,
        phone: users.phone,
        displayName: users.displayName,
        sex: users.sex,
        ageYears: users.ageYears,
        heightCm: users.heightCm,
        activity: users.activity,
        goal: users.goal,
        diet: users.diet,
        cooks: users.cooks,
        tone: users.tone,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (!user) return reply.status(404).send({ error: 'not_found' })

    return reply.status(200).send({
      user,
      // The client uses this to decide between onboarding and the app.
      onboarded: Boolean(user.sex && user.ageYears && user.heightCm && user.goal),
    })
  })

  app.post('/auth/signout', async (request, reply) => {
    if (request.user) await revokeSession(deps.db, request.user.sessionId)
    reply.header('Set-Cookie', 'ogt_session=; Path=/; HttpOnly; Max-Age=0')
    return reply.status(200).send({ signedOut: true })
  })

  /** Sign out everywhere. What someone reaches for when a phone is stolen. */
  app.post('/auth/signout-all', async (request, reply) => {
    const userId = currentUserId(request)
    const count = await revokeAllSessions(deps.db, userId)
    reply.header('Set-Cookie', 'ogt_session=; Path=/; HttpOnly; Max-Age=0')
    return reply.status(200).send({ signedOut: true, sessionsRevoked: count })
  })

  /** Active sessions, so a person can see whether anything looks wrong. */
  app.get('/auth/sessions', async (request, reply) => {
    const userId = currentUserId(request)

    const rows = await deps.db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        ipPrefix: sessions.ipPrefix,
        lastSeenAt: sessions.lastSeenAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .limit(50)

    return reply.status(200).send({
      sessions: rows.map((row) => ({
        ...row,
        current: row.id === request.user?.sessionId,
      })),
    })
  })
}
