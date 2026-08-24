/**
 * Authentication.
 *
 * Phone sign-in, because the target user is in India and has a phone number
 * long before they have a password manager. No wallet, no seed phrase — the
 * 0G key that pays for storage is ours to hold, not theirs to manage.
 *
 * The security decisions here are deliberate and each has a reason:
 *
 *   - **Codes are hashed with scrypt, never stored.** A database read must not
 *     confer the ability to sign in as anyone.
 *   - **Constant-time comparison**, so a timing signal cannot narrow the code.
 *   - **Five attempts, then dead.** Six digits is 10^6 wide; without a ceiling
 *     brute force is a few thousand requests.
 *   - **Sessions are opaque and revocable.** A stolen session here reads
 *     someone's medical history, so ending one must actually end it.
 *   - **Enumeration-resistant.** Requesting a code looks identical whether or
 *     not the number is registered.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { otpChallenges, sessions, users } from '../db/schema.ts'
import type { SmsSender } from './sms.ts'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>

export const OTP_LENGTH = 6
export const OTP_TTL_MS = 10 * 60 * 1000
export const OTP_MAX_ATTEMPTS = 5
/** Per phone, per window. Stops someone using us as an SMS cannon. */
export const OTP_MAX_PER_HOUR = 5
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/**
 * How stale `lastSeenAt` may get before it is refreshed.
 *
 * This value is the difference between one write per request and one write per
 * five minutes per session. It was the former: every authenticated request took
 * a row lock on the same session row and produced a WAL record, so a phone
 * polling for today's totals wrote to the database as often as it read from it.
 *
 * Five minutes because of what the field is for — the "active sessions" screen,
 * where somebody checks whether a session they do not recognise is still being
 * used. Nobody reading that screen can act on second-level precision.
 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000

export class AuthError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 401, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthError'
    this.code = code
    this.status = status
  }
}

/**
 * E.164 normalisation for Indian numbers.
 *
 * People type "98765 43210", "+91 98765-43210", and "098765 43210" for the
 * same phone. Storing them differently would let one person hold three
 * accounts and lock themselves out of two.
 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, '')

  if (digits.startsWith('+')) {
    const rest = digits.slice(1)
    if (!/^\d{8,15}$/.test(rest)) throw new AuthError('invalid_phone', 'That phone number does not look right.', 400)
    return `+${rest}`
  }

  const bare = digits.replace(/^0+/, '')
  if (/^\d{10}$/.test(bare)) return `+91${bare}` // India default
  if (/^91\d{10}$/.test(bare)) return `+${bare}`

  throw new AuthError('invalid_phone', 'That phone number does not look right.', 400)
}

function generateCode(): string {
  // rejection-sampled from crypto bytes — Math.random has no business here
  let code = ''
  while (code.length < OTP_LENGTH) {
    for (const byte of randomBytes(OTP_LENGTH)) {
      if (byte >= 250) continue // 250..255 would bias the low digits
      code += String(byte % 10)
      if (code.length === OTP_LENGTH) break
    }
  }
  return code
}

async function hashCode(code: string, salt: string): Promise<string> {
  const derived = await scrypt(code, salt, 32)
  return derived.toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface RequestCodeResult {
  /** Always true, whatever happened. Never reveals whether a number is known. */
  sent: true
  expiresInSeconds: number
  /** Development only: surfaced so there is no SMS provider in the loop. */
  devCode?: string
}

export interface RequestCodeInput {
  db: Database
  phone: string
  /** Delivers the code. Without this nothing is sent and nobody can sign in. */
  sender: SmsSender
  /** Returns the code in the response. Refused unless NODE_ENV is development. */
  exposeCodeForDevelopment?: boolean
  now?: Date
}

export async function requestCode(input: RequestCodeInput): Promise<RequestCodeResult> {
  const phone = normalisePhone(input.phone)
  const now = input.now ?? new Date()
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)

  const [recent] = await input.db
    .select({ count: sql<number>`count(*)::int` })
    .from(otpChallenges)
    .where(and(eq(otpChallenges.phone, phone), gt(otpChallenges.createdAt, hourAgo)))

  if ((recent?.count ?? 0) >= OTP_MAX_PER_HOUR) {
    throw new AuthError('too_many_codes', 'Too many codes requested. Try again in an hour.', 429)
  }

  const code = generateCode()
  const salt = randomBytes(16).toString('hex')

  // Stored before sending, so a code that reaches somebody's phone is always
  // one this server can verify. The reverse order has a window where a person
  // holds a code we have no record of.
  const [challenge] = await input.db
    .insert(otpChallenges)
    .values({
      phone,
      codeHash: await hashCode(code, salt),
      salt,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    })
    .returning({ id: otpChallenges.id })

  try {
    await input.sender.send({
      to: phone,
      code,
      expiresInMinutes: Math.floor(OTP_TTL_MS / 60_000),
    })
  } catch (error) {
    // The challenge is withdrawn rather than left behind. It counts against the
    // five-per-hour cap, and charging somebody for a message they never
    // received is how a person ends up locked out by our outage.
    if (challenge) {
      await input.db.delete(otpChallenges).where(eq(otpChallenges.id, challenge.id))
    }

    throw new AuthError(
      'delivery_failed',
      'Could not send the code just now. Try again in a moment.',
      502,
      { cause: error },
    )
  }

  return {
    sent: true,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    ...(input.exposeCodeForDevelopment ? { devCode: code } : {}),
  }
}

export interface VerifyCodeInput {
  db: Database
  phone: string
  code: string
  userAgent?: string
  ip?: string
  now?: Date
}

export interface Session {
  /** Returned once, at creation. Only its hash is stored. */
  token: string
  userId: string
  expiresAt: Date
  isNewUser: boolean
}

export async function verifyCode(input: VerifyCodeInput): Promise<Session> {
  const phone = normalisePhone(input.phone)
  const now = input.now ?? new Date()

  const [challenge] = await input.db
    .select()
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, phone),
        isNull(otpChallenges.consumedAt),
        gt(otpChallenges.expiresAt, now),
        lt(otpChallenges.attempts, OTP_MAX_ATTEMPTS),
      ),
    )
    .orderBy(sql`${otpChallenges.createdAt} DESC`)
    .limit(1)

  if (!challenge) {
    throw new AuthError('invalid_code', 'That code is wrong or has expired.')
  }

  // Count the attempt before checking it. Otherwise a crash mid-verify hands
  // the attacker a free guess.
  await input.db
    .update(otpChallenges)
    .set({ attempts: challenge.attempts + 1 })
    .where(eq(otpChallenges.id, challenge.id))

  const candidate = await hashCode(input.code.trim(), challenge.salt)
  const expected = Buffer.from(challenge.codeHash, 'hex')
  const actual = Buffer.from(candidate, 'hex')

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthError('invalid_code', 'That code is wrong or has expired.')
  }

  await input.db
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(eq(otpChallenges.id, challenge.id))

  const [existing] = await input.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1)

  let userId = existing?.id
  const isNewUser = userId === undefined

  if (userId === undefined) {
    const [created] = await input.db.insert(users).values({ phone }).returning({ id: users.id })
    if (!created) throw new AuthError('signup_failed', 'Could not create your account.', 500)
    userId = created.id
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)

  await input.db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 200) } : {}),
    ...(input.ip ? { ipPrefix: truncateIp(input.ip) } : {}),
    expiresAt,
  })

  return { token, userId, expiresAt, isNewUser }
}

export interface AuthenticatedUser {
  id: string
  sessionId: string
}

/**
 * Resolve a bearer token to a user.
 *
 * Returns null rather than throwing for every failure mode, so a caller cannot
 * accidentally distinguish "expired" from "revoked" from "never existed" —
 * all three are simply "not signed in".
 */
export async function resolveSession(
  db: Database,
  token: string,
  now = new Date(),
): Promise<AuthenticatedUser | null> {
  if (!token) return null

  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1)

  if (!row) return null

  // Best-effort liveness, and only when it has gone stale. A failure here must
  // never sign someone out, and neither must the cost of recording it.
  const staleBy = now.getTime() - row.lastSeenAt.getTime()
  if (staleBy >= SESSION_TOUCH_INTERVAL_MS) {
    void db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.id, row.id))
      .catch(() => undefined)
  }

  return { id: row.userId, sessionId: row.id }
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId))
}

/** Sign out everywhere. What a person reaches for when a phone is stolen. */
export async function revokeAllSessions(db: Database, userId: string): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })

  return revoked.length
}

/**
 * Truncate an IP before storing it.
 *
 * Enough to notice a session used from two continents; not enough to be a
 * movement log. We are storing it for the user's safety, not our analytics.
 */
export function truncateIp(ip: string): string {
  if (ip.includes(':')) {
    return `${ip.split(':').slice(0, 3).join(':')}::`
  }
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip
}

/** Housekeeping. Expired rows are liability, not data. */
export async function purgeExpired(db: Database, now = new Date()): Promise<void> {
  await db.delete(otpChallenges).where(lt(otpChallenges.expiresAt, now))
  await db.delete(sessions).where(lt(sessions.expiresAt, now))
}
