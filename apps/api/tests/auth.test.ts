/**
 * Authentication.
 *
 * Before this existed, sixteen routes took `userId` from the request body —
 * anyone who could guess a UUID could read a stranger's medical history. These
 * tests cover both halves of the fix: the crypto, and the structural guarantee
 * that no route can ever trust client-supplied identity again.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startHarness } from './helpers/e2e.ts'
import {
  AuthError,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_PER_HOUR,
  hashToken,
  normalisePhone,
  truncateIp,
} from '../src/services/auth.ts'

const SRC = join(import.meta.dirname, '..', 'src')

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

// -------------------------------------------------------------- phone input

test('the same Indian number in any format normalises identically', () => {
  // Otherwise one person holds three accounts and is locked out of two.
  const forms = ['9876543210', '+91 9876543210', '09876543210', '+91-98765-43210', '91 9876543210']
  const normalised = forms.map(normalisePhone)
  for (const value of normalised) {
    assert.equal(value, '+919876543210', `mismatch for one of ${forms.join(', ')}`)
  }
})

test('international numbers keep their own country code', () => {
  assert.equal(normalisePhone('+14155552671'), '+14155552671')
  assert.equal(normalisePhone('+442071838750'), '+442071838750')
})

test('nonsense is rejected rather than coerced', () => {
  for (const bad of ['', 'hello', '123', '+', '+abc', '12345']) {
    assert.throws(() => normalisePhone(bad), AuthError, `accepted "${bad}"`)
  }
})

// ------------------------------------------------------------------ tokens

test('tokens are stored hashed, never in plaintext', () => {
  const token = 'a-secret-session-token'
  const hash = hashToken(token)

  assert.notEqual(hash, token)
  assert.equal(hash.length, 64, 'sha256 hex')
  assert.equal(hashToken(token), hash, 'and must be deterministic to look up')
})

test('different tokens hash differently', () => {
  assert.notEqual(hashToken('a'), hashToken('b'))
})

// ---------------------------------------------------------------- ip privacy

test('stored IPs are truncated, not recorded exactly', () => {
  // Enough to spot a session used from two continents. Not a movement log.
  assert.equal(truncateIp('203.0.113.42'), '203.0.113.0')
  assert.equal(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::')
})

test('a malformed IP is not silently mangled into something wrong', () => {
  assert.equal(truncateIp('not-an-ip'), 'not-an-ip')
})

// ------------------------------------------------------------ brute force

test('the attempt ceiling is low enough to matter', () => {
  // Six digits is 10^6 wide. Without a ceiling, brute force is a few thousand
  // requests — which is minutes, not years.
  assert.ok(OTP_MAX_ATTEMPTS <= 5, `${OTP_MAX_ATTEMPTS} attempts is too generous`)
  assert.ok(OTP_MAX_PER_HOUR <= 5, 'and we must not be usable as an SMS cannon')
})

test('an attempt is counted before the code is checked', () => {
  // Otherwise a crash mid-verify hands the attacker a free guess.
  const source = code(readFileSync(join(SRC, 'services', 'auth.ts'), 'utf8'))

  // Scope to verifyCode: timingSafeEqual also appears in the import line, and
  // matching that instead would make this assertion meaningless.
  const fn = source.slice(source.indexOf('export async function verifyCode'))
  const incrementAt = fn.indexOf('attempts: challenge.attempts + 1')
  const compareAt = fn.indexOf('timingSafeEqual')

  assert.ok(incrementAt > -1, 'verifyCode must increment the attempt counter')
  assert.ok(compareAt > -1, 'verifyCode must compare in constant time')
  assert.ok(incrementAt < compareAt, 'the attempt must be recorded before it is evaluated')
})

test('codes are compared in constant time', () => {
  const source = code(readFileSync(join(SRC, 'services', 'auth.ts'), 'utf8'))
  assert.match(source, /timingSafeEqual/, 'a timing signal would narrow the code')
  assert.doesNotMatch(source, /codeHash\s*===\s*/, 'and a plain === would leak one')
})

test('codes are never stored in plaintext', () => {
  const source = code(readFileSync(join(SRC, 'services', 'auth.ts'), 'utf8'))
  assert.match(source, /codeHash: await hashCode\(/, 'a database read must not confer sign-in')
})

test('codes come from a CSPRNG, not Math.random', () => {
  const source = code(readFileSync(join(SRC, 'services', 'auth.ts'), 'utf8'))
  assert.doesNotMatch(source, /Math\.random/)
  assert.match(source, /randomBytes/)
})

// ------------------------------------------------------- enumeration safety

test('every verification failure reads the same to the client', () => {
  // Distinguishing wrong from expired from used tells an attacker which codes
  // are worth retrying.
  const source = readFileSync(join(SRC, 'services', 'auth.ts'), 'utf8')
  const messages = [...source.matchAll(/AuthError\('invalid_code',\s*'([^']+)'/g)].map((m) => m[1])

  assert.ok(messages.length >= 2, 'expected several failure paths')
  assert.equal(new Set(messages).size, 1, `failure messages diverge: ${messages.join(' | ')}`)
})

test('requesting a code never reveals whether the number is registered', () => {
  const source = code(readFileSync(join(SRC, 'services', 'auth.ts'), 'utf8'))
  // requestCode must not branch on whether a user exists.
  const fn = source.slice(source.indexOf('export async function requestCode'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.doesNotMatch(body, /from\(users\)/, 'requestCode must not look the user up')
})

// ------------------------------------------------ the structural guarantee

test('no route reads a user id from the client', () => {
  // The whole vulnerability, in one assertion.
  const routes = readdirSync(join(SRC, 'routes')).filter((f) => f.endsWith('.ts'))

  for (const file of routes) {
    const source = code(readFileSync(join(SRC, 'routes', file), 'utf8'))
    assert.doesNotMatch(
      source,
      /userId:\s*z\.string\(\)\.uuid\(\)/,
      `${file} still accepts a client-supplied userId`,
    )
    assert.doesNotMatch(source, /body\.userId|query\.userId|params\.userId/, `${file} reads userId from input`)
  }
})

test('every route file that needs an identity derives it from the session', () => {
  const routes = readdirSync(join(SRC, 'routes')).filter((f) => f.endsWith('.ts'))

  for (const file of routes) {
    const source = code(readFileSync(join(SRC, 'routes', file), 'utf8'))
    if (!/\buserId\b/.test(source)) continue
    assert.match(
      source,
      /currentUserId\(request\)/,
      `${file} uses a userId it did not get from the session`,
    )
  }
})

test('auth is opt-out, so a new route is protected by default', () => {
  const server = code(readFileSync(join(SRC, 'server.ts'), 'utf8'))
  assert.match(server, /PUBLIC_ROUTES/, 'there must be an explicit allowlist')
  assert.match(server, /app\.register\(authPlugin/, 'and the plugin must be registered')

  // The allowlist must stay small and must never include a data route.
  const list = /const PUBLIC_ROUTES = \[([\s\S]*?)\] as const/.exec(
    readFileSync(join(SRC, 'server.ts'), 'utf8'),
  )
  assert.ok(list, 'PUBLIC_ROUTES must be a literal so it can be reviewed')
  for (const forbidden of ['/users/', '/meals', '/chat', '/export']) {
    assert.ok(!list[1]!.includes(forbidden), `${forbidden} must never be public`)
  }
})

test('currentUserId throws rather than falling back', () => {
  // A route reaching this without a session is a wiring bug. Failing loudly is
  // far better than serving somebody else's data.
  const source = code(readFileSync(join(SRC, 'plugins', 'auth.ts'), 'utf8'))
  assert.match(source, /if \(!request\.user\)[\s\S]{0,200}throw new Error/)
})

test('the auth hook matches on the route pattern, not the raw URL', () => {
  // Matching a concrete path would let someone craft a URL that looks public.
  const source = code(readFileSync(join(SRC, 'plugins', 'auth.ts'), 'utf8'))
  assert.match(source, /routeOptions\?\.url/)
})

test('session cookies are httpOnly and sameSite', () => {
  const source = readFileSync(join(SRC, 'routes', 'auth.ts'), 'utf8')
  assert.match(source, /'HttpOnly'/, 'page script must not be able to read the session')
  assert.match(source, /'SameSite=Lax'/, 'a cross-site post must not ride it')
  assert.match(source, /secureCookies \? \['Secure'\]/, 'and it must be Secure in production')
})

test('the dev code escape hatch is gated on the server, not the request', () => {
  const source = code(readFileSync(join(SRC, 'routes', 'auth.ts'), 'utf8'))
  assert.match(source, /exposeCodeForDevelopment: deps\.isDevelopment/)
  assert.doesNotMatch(source, /exposeCodeForDevelopment:\s*(body|request)/, 'never client-controlled')
})

test('in production the sign-in code never comes back in the response', async () => {
  /*
   * The gate above is read from the source, which proves the wiring and not the
   * behaviour. This is the one that would matter: a build where NODE_ENV is not
   * development must hand back nothing an attacker could sign in with.
   *
   * The failure it guards against is total. Anyone who can guess a phone number
   * gets the code for it, and the whole point of a one-time code is that only
   * the person holding the phone has it.
   */
  const previous = process.env.NODE_ENV

  try {
    const harness = await startHarness({ NODE_ENV: 'production' })

    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/auth/request-code',
        payload: { phone: '+919876500099' },
      })

      assert.equal(response.statusCode, 200)

      const body = response.json() as Record<string, unknown>
      assert.equal(body.devCode, undefined, 'the code must never reach the client in production')

      // And it really was sent, so this is not passing because nothing happened.
      assert.equal(harness.sentCodes.length, 1)
      const sent = harness.sentCodes[0]!.code
      assert.ok(sent.length >= 4)

      // The strong form: the code appears nowhere in the response at all, under
      // any key. A rename would slip past a check for `devCode` alone.
      assert.ok(
        !JSON.stringify(body).includes(sent),
        `the response contained the code itself: ${JSON.stringify(body)}`,
      )
    } finally {
      await harness.close()
    }
  } finally {
    // Restored explicitly: the harness writes to the real process env, so a
    // later test in the same run would otherwise inherit production.
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})
