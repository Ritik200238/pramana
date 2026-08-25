/**
 * The advisory lock, against two Postgres sessions genuinely competing.
 *
 * The unit tests prove this code calls `pg_try_advisory_lock` correctly: taken
 * and released on one reserved connection, refused without leaking, released in
 * a `finally`. What they cannot prove is the premise underneath — that Postgres
 * refuses the second session — because they run against a recording fake, and
 * PGlite is single-session so it cannot contend with itself.
 *
 * This closes that. Point it at any Postgres and it runs; without one it skips
 * loudly rather than passing.
 *
 *   DATABASE_URL=postgres://... npm run test:locks -w @ogt/api
 *
 * A throwaway server is enough — nothing here writes a table:
 *
 *   docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:18
 *
 * (Attempted on the machine this was written on with an embedded PostgreSQL 18.
 * initdb succeeded and the server reached "ready to accept connections", then a
 * background worker died with 0xC0000142 — a DLL initialisation failure in that
 * sandbox, not a fault in this code. Hence a test that travels rather than a
 * result asserted from a machine that could not produce one.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { lockKey, postgresPassLock } from '../../src/jobs/pass-lock.ts'

const URL = process.env['DATABASE_URL']
const skip = URL ? false : 'set DATABASE_URL to a Postgres this test may connect to'

test('a second instance is refused the lock the first is holding', { skip }, async () => {
  /*
   * Two pools, because two instances are two processes. One pool with two
   * connections would not prove the same thing.
   *
   * `max` is 2 rather than 1 for a reason worth knowing: `reserve()` takes a
   * connection out of the pool and holds it for the life of the lock, so a pool
   * of one has nothing left to serve anything else and the next query on it
   * waits forever. Production runs a pool of ten, which is why the worker does
   * not deadlock on itself — but it is a real edge and it is the first thing
   * this test hit.
   */
  const first = postgres(URL!, { max: 2, connect_timeout: 10 })
  const second = postgres(URL!, { max: 2, connect_timeout: 10 })

  try {
    const lockA = postgresPassLock(first)
    const lockB = postgresPassLock(second)

    const held = await lockA('scheduler')
    assert.notEqual(held, null, 'an uncontended lock must be granted')

    // The property the whole fix rests on.
    const denied = await lockB('scheduler')
    assert.equal(denied, null, 'a second instance must not get a lock the first holds')

    // A different worker is a different lock, or the three would serialise
    // against each other for no reason.
    const other = await lockB('anchor')
    assert.notEqual(other, null, 'a different worker must not be blocked by the scheduler lock')
    await other!()

    // Postgres agrees the lock is real and is held exactly once.
    const [visible] = await first<{ n: number }[]>`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and objid = ${(lockKey('scheduler') & 0xffffffffn).toString()}::bigint
    `
    assert.ok((visible?.n ?? 0) >= 1, 'the lock must be visible in pg_locks')

    await held!()

    // And it is genuinely released, not merely dropped from our bookkeeping.
    const regained = await lockB('scheduler')
    assert.notEqual(regained, null, 'the lock must be available once the holder releases it')
    await regained!()
  } finally {
    await first.end({ timeout: 5 })
    await second.end({ timeout: 5 })
  }
})
