/**
 * The journey, against a real database.
 *
 * Every test below drives the server the way a phone does: over HTTP, through
 * the auth plugin, into Postgres. Nothing reaches inside to arrange state that
 * a user could not have created themselves, because a fixture that forges a
 * session cannot notice when the thing it forged stops working.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signIn, startHarness, VALID_PROFILE, type Harness } from './helpers/e2e.ts'

/** Routes reachable with no session. Anything else must refuse one. */
const PUBLIC = new Set([
  'GET /health',
  'GET /ready',
  'POST /auth/request-code',
  'POST /auth/verify',
  'POST /auth/signout',
])

/** Exempt from the session hook because they carry an operator secret instead. */
const OPERATOR = new Set(['POST /admin/run-snapshots'])

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  const harness = await startHarness()
  try {
    await body(harness)
  } finally {
    await harness.close()
  }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

// ------------------------------------------------------------- the first run

test('a new person can sign in and reach their first real number', async () => {
  await withHarness(async (h) => {
    const { token, isNewUser } = await signIn(h, '98765 43210')
    assert.equal(isNewUser, true, 'a first sign-in creates the account')

    // Before onboarding the app must be told to ask, not to show a dashboard.
    const before = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    assert.equal(before.statusCode, 200)
    assert.equal(before.json().onboarded, false)

    const profile = await h.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: auth(token),
      payload: VALID_PROFILE,
    })
    assert.equal(profile.statusCode, 200, profile.body)

    const targets = profile.json().targets
    assert.ok(targets.calories > 1200, 'a real target, not a placeholder')
    assert.ok(targets.proteinG > 0)

    const after = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    assert.equal(after.json().onboarded, true, 'onboarding must actually complete')

    const today = await h.app.inject({ method: 'GET', url: '/users/me/today', headers: auth(token) })
    assert.equal(today.statusCode, 200, today.body)
    assert.equal(today.json().mealCount, 0)
  })
})

test('signing in twice is the same account, not a second one', async () => {
  await withHarness(async (h) => {
    // The same person, typed three ways people actually type it.
    const first = await signIn(h, '9876543210')
    const second = await signIn(h, '+91 98765-43210')

    assert.equal(first.isNewUser, true)
    assert.equal(second.isNewUser, false, 'a differently formatted number is the same person')

    const a = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(first.token) })
    const b = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(second.token) })
    assert.equal(a.json().user.id, b.json().user.id, 'one person, one account')
  })
})

test('onboarding fills in the existing account rather than creating another', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9000000001')

    await h.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: auth(token),
      payload: VALID_PROFILE,
    })

    // The defect this guards: a second creation path produced rows with no
    // phone attached, which nobody could ever sign in to again.
    const rows = await h.db.execute('select count(*)::int as count from users')
    const count = (rows as unknown as { rows?: Array<{ count: number }> }).rows?.[0]?.count
    assert.equal(count ?? (rows as unknown as Array<{ count: number }>)[0]?.count, 1)
  })
})

// --------------------------------------------------------------- the session

test('every route that is not on the allowlist refuses an anonymous caller', async () => {
  await withHarness(async (h) => {
    // Enumerated from the server's own route table, so a route added tomorrow
    // is covered by this test without anybody remembering to add it.
    const routes: Array<{ method: string; url: string }> = []
    for (const line of h.app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^.*?([\/][^\s(]*)\s*\((.+?)\)/.exec(line)
      if (!match) continue
      for (const method of match[2]!.split(',')) {
        routes.push({ method: method.trim(), url: match[1]!.replace(/\/$/, '') || '/' })
      }
    }

    assert.ok(routes.length > 15, `expected the full route table, saw ${routes.length}`)

    const leaked: string[] = []
    for (const route of routes) {
      const key = `${route.method} ${route.url}`
      if (PUBLIC.has(key) || OPERATOR.has(key) || route.method === 'HEAD') continue

      const response = await h.app.inject({
        method: route.method as 'GET',
        url: route.url.replace(/:\w+/g, '00000000-0000-4000-8000-000000000000'),
        ...(route.method === 'GET' ? {} : { payload: {} }),
      })

      // 404 is acceptable for a path whose params we invented; anything that is
      // not a refusal means the route served an anonymous caller.
      if (response.statusCode !== 401 && response.statusCode !== 404) {
        leaked.push(`${key} -> ${response.statusCode}`)
      }
    }

    assert.deepEqual(leaked, [], 'these routes answered without a session')
  })
})

test('one person cannot reach another person through their own session', async () => {
  await withHarness(async (h) => {
    const alice = await signIn(h, '9000000002')
    const bob = await signIn(h, '9000000003')

    for (const person of [alice, bob]) {
      await h.app.inject({
        method: 'POST',
        url: '/users/me/profile',
        headers: auth(person.token),
        payload: VALID_PROFILE,
      })
    }

    const aliceMe = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(alice.token) })
    const bobMe = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(bob.token) })
    assert.notEqual(aliceMe.json().user.id, bobMe.json().user.id)

    // The paths say `me`, so there is no id to swap. This asserts the property
    // that makes that safe: the answer is derived from the token alone.
    assert.equal(aliceMe.json().user.phone, '+919000000002')
    assert.equal(bobMe.json().user.phone, '+919000000003')
  })
})

test('signing out ends the session immediately', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9000000004')

    const before = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    assert.equal(before.statusCode, 200)

    await h.app.inject({ method: 'POST', url: '/auth/signout', headers: auth(token) })

    // Sessions are opaque and revocable precisely so this is possible. A JWT
    // would still be accepted here until it expired.
    const after = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    assert.equal(after.statusCode, 401, 'a revoked token must stop working at once')
  })
})

test('the code is actually handed to a sender, not merely stored', async () => {
  await withHarness(async (h) => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { phone: '9700000001' },
    })
    assert.equal(response.statusCode, 200)

    // The defect this guards: nothing sent anything. In production the code was
    // withheld from the response too, so it existed nowhere a person could
    // reach it and every sign-in was impossible while this endpoint said 200.
    assert.equal(h.sentCodes.length, 1, 'a code request must attempt delivery')
    assert.equal(h.sentCodes[0]!.to, '+919700000001')
    assert.match(h.sentCodes[0]!.code, /^\d{6}$/)

    // And the code that was sent is the one that works.
    const verified = await h.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '9700000001', code: h.sentCodes[0]!.code },
    })
    assert.equal(verified.statusCode, 200, verified.body)
  })
})

test('a delivery failure is reported and does not spend the hourly quota', async () => {
  await withHarness(async (h) => {
    h.failNextSend(true)

    const failed = await h.app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { phone: '9700000002' },
    })
    assert.equal(failed.statusCode, 502, 'a message nobody received is not a success')

    const rows = await h.db.execute(
      "select count(*)::int as count from otp_challenges where phone = '+919700000002'",
    )
    const list = (rows as unknown as { rows?: Array<{ count: number }> }).rows ?? rows
    // Charging somebody for a message they never got is how our outage becomes
    // their lockout: five of these and they are capped for an hour.
    assert.equal((list as Array<{ count: number }>)[0]?.count, 0, 'the challenge must be withdrawn')

    h.failNextSend(false)
    const recovered = await h.app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { phone: '9700000002' },
    })
    assert.equal(recovered.statusCode, 200, 'and they can try again immediately')
  })
})

test('a forged or altered token is refused', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9000000005')

    for (const bad of [`${token}x`, token.slice(0, -1), 'not-a-token', '']) {
      const response = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${bad}` },
      })
      assert.equal(response.statusCode, 401, `accepted a bad token: ${bad.slice(0, 12)}`)
    }
  })
})

// ------------------------------------------------------------ the code itself

test('a wrong code is rejected and the attempt is counted', async () => {
  await withHarness(async (h) => {
    const phone = '9000000006'
    await h.app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone } })

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { phone, code: '000000' },
      })
      assert.notEqual(response.statusCode, 200, 'a wrong code must never sign anybody in')
    }

    // The challenge is now spent. Even the right code cannot rescue it, which
    // is what stops a six-digit space being walked.
    const rows = await h.db.execute(
      "select attempts from otp_challenges where phone = '+919000000006'",
    )
    const list = (rows as unknown as { rows?: Array<{ attempts: number }> }).rows ?? rows
    const attempts = (list as Array<{ attempts: number }>)[0]?.attempts
    assert.ok((attempts ?? 0) >= 5, `attempts should have been counted, saw ${attempts}`)
  })
})

test('a code cannot be replayed after it has been used', async () => {
  await withHarness(async (h) => {
    const phone = '9000000007'
    const requested = await h.app.inject({
      method: 'POST',
      url: '/auth/request-code',
      payload: { phone },
    })
    const { devCode } = requested.json() as { devCode: string }

    const first = await h.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone, code: devCode },
    })
    assert.equal(first.statusCode, 200)

    const replay = await h.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone, code: devCode },
    })
    assert.equal(replay.statusCode, 401, 'a used code must not work twice')
  })
})

// ------------------------------------------------------------- the operator

test('the admin endpoint refuses everyone without the operator secret', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9000000008')

    // Being signed in is not authorisation. This was the defect: any account
    // could trigger storage writes and gas spend across every other user.
    const asUser = await h.app.inject({
      method: 'POST',
      url: '/admin/run-snapshots',
      headers: auth(token),
    })
    assert.equal(asUser.statusCode, 404, 'a session must not be enough')

    const wrongSecret = await h.app.inject({
      method: 'POST',
      url: '/admin/run-snapshots',
      headers: { 'x-admin-token': 'wrong' },
    })
    assert.equal(wrongSecret.statusCode, 404)

    const authorised = await h.app.inject({
      method: 'POST',
      url: '/admin/run-snapshots',
      headers: { 'x-admin-token': h.adminToken },
    })
    assert.equal(authorised.statusCode, 200, authorised.body)
  })
})

// ----------------------------------------------------------- the rate limits

test('a flood is turned away before it costs a session lookup', async () => {
  await withHarness(async (h) => {
    let sawRateLimit = false

    for (let i = 0; i < 130; i += 1) {
      const response = await h.app.inject({
        method: 'GET',
        url: '/users/me/today',
        headers: { authorization: 'Bearer definitely-not-a-session' },
      })
      if (response.statusCode === 429) {
        sawRateLimit = true
        break
      }
      assert.equal(response.statusCode, 401)
    }

    // 429 rather than 401 is the observable proof that the IP limiter runs
    // ahead of the auth hook. If the order were reversed every one of those
    // requests would have cost a database round trip first.
    assert.ok(sawRateLimit, 'an unauthenticated flood must hit the limiter, not the database')
  })
})

test('requesting codes for many numbers from one host is capped', async () => {
  await withHarness(async (h) => {
    const statuses: number[] = []
    for (let i = 0; i < 10; i += 1) {
      // Ten different numbers: the per-phone cap cannot see this pattern, only
      // the per-IP cap can.
      const response = await h.app.inject({
        method: 'POST',
        url: '/auth/request-code',
        payload: { phone: `900000010${i}` },
      })
      statuses.push(response.statusCode)
    }

    assert.ok(
      statuses.includes(429),
      `walking the numbering plan must be capped, saw ${statuses.join(',')}`,
    )
  })
})

// ------------------------------------------------------------- the safeguards

test('a profile that fails the safety gate is refused and stored nowhere', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9000000009')

    const response = await h.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: auth(token),
      // A minor. The gate must refuse this at the door.
      payload: { ...VALID_PROFILE, ageYears: 14 },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().blocked, true, 'a minor must not be onboarded')

    const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    assert.equal(me.json().onboarded, false, 'a refused profile must not have been written')
  })
})

test('a busy client does not write to the database on every request', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9700000003')

    const seenAt = async () => {
      const rows = await h.db.execute('select last_seen_at from sessions limit 1')
      const list = (rows as unknown as { rows?: Array<{ last_seen_at: string }> }).rows ?? rows
      return (list as Array<{ last_seen_at: string }>)[0]!.last_seen_at
    }

    const before = await seenAt()

    // The PWA polls. Recording liveness on every one of these took a row lock
    // and wrote a WAL record per request, so a phone reading today's totals
    // wrote to the database as often as it read from it.
    for (let i = 0; i < 8; i += 1) {
      await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    }

    assert.equal(await seenAt(), before, 'liveness must not be rewritten on every request')
  })
})

test('liveness is still recorded once it has gone stale', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9700000004')

    // Age the session past the touch interval rather than waiting for it.
    await h.db.execute(
      "update sessions set last_seen_at = now() - interval '10 minutes'",
    )

    await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    // The update is deliberately not awaited by the request, so give the
    // best-effort write a turn of the loop to land.
    await new Promise((resolve) => setImmediate(resolve))

    const rows = await h.db.execute(
      "select now() - last_seen_at < interval '1 minute' as fresh from sessions limit 1",
    )
    const list = (rows as unknown as { rows?: Array<{ fresh: boolean }> }).rows ?? rows
    assert.equal(
      (list as Array<{ fresh: boolean }>)[0]!.fresh,
      true,
      'the active-sessions screen still needs to show a recent time',
    )
  })
})

test('a real user is actually eligible for a snapshot', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9700000005')
    await h.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: auth(token),
      payload: VALID_PROFILE,
    })

    // The bug this guards was total and silent: the snapshot query filtered on
    // record_pub_key, nothing ever wrote that column, so the queue was empty
    // for every user forever — no storage, no anchoring, no coach — and an
    // empty queue is indistinguishable from finished work.
    const { findUsersDueForSnapshot } = await import('../src/jobs/scheduler.ts')
    const due = await findUsersDueForSnapshot(h.db, 10)

    assert.equal(due.length, 1, 'a freshly onboarded user must be due for a snapshot')
  })
})

test('the record key is created on demand and never changes', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9700000006')
    await h.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: auth(token),
      payload: VALID_PROFILE,
    })

    const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    const userId = me.json().user.id

    const { ensureRecordKey } = await import('../src/services/record-key.ts')
    const seed = 'a-master-seed-long-enough-to-be-accepted'

    const first = await ensureRecordKey(h.db, seed, userId)
    const second = await ensureRecordKey(h.db, seed, userId)

    // Compressed secp256k1. Stable, because a record encrypted to one key and
    // an anchor owned by another would be unrecoverable.
    assert.match(first, /^0x0[23][0-9a-f]{64}$/)
    assert.equal(second, first, 'the key must never change under a user')

    const rows = await h.db.execute(
      `select record_pub_key from users where id = '${userId}'`,
    )
    const list = (rows as unknown as { rows?: Array<{ record_pub_key: string }> }).rows ?? rows
    assert.equal((list as Array<{ record_pub_key: string }>)[0]?.record_pub_key, first)
  })
})

test('expired codes and dead sessions are actually purged', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9700000007')

    // Age everything past its expiry, as time would.
    await h.db.execute("update otp_challenges set expires_at = now() - interval '1 day'")
    await h.db.execute("update sessions set expires_at = now() - interval '1 day'")

    const { startScheduler } = await import('../src/jobs/scheduler.ts')
    const scheduler = startScheduler({
      db: h.db,
      storage: { signerAddress: '0x' } as never,
      logger: h.app.log,
    })
    scheduler.stop()
    await scheduler.runOnce()

    // purgeExpired existed from the beginning, said expired rows are liability
    // rather than data, and was called by nothing — so every one-time code and
    // dead session was kept forever, on the table every request reads.
    for (const table of ['otp_challenges', 'sessions']) {
      const rows = await h.db.execute(`select count(*)::int as count from ${table}`)
      const list = (rows as unknown as { rows?: Array<{ count: number }> }).rows ?? rows
      assert.equal((list as Array<{ count: number }>)[0]?.count, 0, `${table} was not purged`)
    }

    // And the now-expired session really is dead.
    const after = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    assert.equal(after.statusCode, 401)
  })
})

test('a changed master seed is refused rather than silently orphaning records', async () => {
  await withHarness(async (h) => {
    const { token } = await signIn(h, '9700000008')
    await h.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: auth(token),
      payload: VALID_PROFILE,
    })

    const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })
    const userId = me.json().user.id

    const { ensureRecordKey, SeedDriftError } = await import('../src/services/record-key.ts')

    const original = 'a-master-seed-long-enough-to-be-accepted'
    await ensureRecordKey(h.db, original, userId)

    // Both the address and the key are recorded, so the derivation has a witness.
    const rows = await h.db.execute(
      `select record_pub_key, anchor_address from users where id = '${userId}'`,
    )
    const list =
      (rows as unknown as { rows?: Array<{ record_pub_key: string; anchor_address: string }> })
        .rows ?? rows
    const stored = (list as Array<{ record_pub_key: string; anchor_address: string }>)[0]!
    assert.match(stored.anchor_address, /^0x[0-9a-fA-F]{40}$/)
    assert.ok(stored.record_pub_key)

    /*
     * A rotated, retyped, or wrongly restored seed moves every derivation. New
     * records would be encrypted to a key the old ones were not, and anchored
     * to an address owning none of their history — with nothing failing. The
     * data would simply stop being theirs.
     */
    await assert.rejects(
      () => ensureRecordKey(h.db, 'a-completely-different-seed-of-sufficient-length', userId),
      (error: unknown) => {
        assert.ok(error instanceof SeedDriftError)
        return true
      },
    )

    // And the original seed still works, unchanged.
    assert.equal(await ensureRecordKey(h.db, original, userId), stored.record_pub_key)
  })
})

test('readiness reports the database it actually depends on', async () => {
  await withHarness(async (h) => {
    const response = await h.app.inject({ method: 'GET', url: '/ready' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().checks.database, 'ok')
  })
})
