/**
 * One pass at a time, across instances.
 *
 * Every worker guards itself with a boolean, and every one of those booleans is
 * per-process. The guard reads as if it prevents concurrent passes; it prevents
 * concurrent passes *here*. On two instances the scheduler duplicates a paid
 * upload to 0G Storage before any row exists to reveal the duplicate.
 *
 * So these tests are about the lock actually being load-bearing: taken before
 * work, released after it, released when the pass throws, and — the way this
 * particular fix is usually got wrong — released on the same connection it was
 * taken on rather than on whichever one the pool hands over next.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { lockKey, postgresPassLock } from '../src/jobs/pass-lock.ts'
import { startScheduler } from '../src/jobs/scheduler.ts'
import * as schema from '../src/db/schema.ts'
import type { Database } from '../src/db/index.ts'

const JOBS = join(import.meta.dirname, '..', 'src', 'jobs')

/** A pool that hands out a distinct connection each time, and records traffic. */
function fakePool(options: { locked?: boolean } = {}) {
  const issued: Array<{ id: number; queries: string[]; released: boolean }> = []

  const reserve = async () => {
    const connection = { id: issued.length, queries: [] as string[], released: false }
    issued.push(connection)

    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.raw.join('?').replace(/\s+/g, ' ').trim()
      connection.queries.push(text)
      return Promise.resolve([{ locked: options.locked ?? true }]) as never
    }

    return Object.assign(sql, {
      release: () => {
        connection.released = true
      },
    })
  }

  return { sql: { reserve } as never, issued }
}

test('the lock is taken and released on one and the same connection', async () => {
  const pool = fakePool()
  const release = await postgresPassLock(pool.sql)('scheduler')

  assert.notEqual(release, null, 'an uncontended lock must be granted')
  assert.equal(pool.issued.length, 1, 'a connection must be reserved for the lock')
  assert.match(pool.issued[0]!.queries[0]!, /pg_try_advisory_lock/)
  assert.equal(pool.issued[0]!.released, false, 'the connection is held while the lock is')

  await release!()

  // The whole point of reserving. Unlocking through the pool would run on some
  // other connection, where the lock is not held and the unlock does nothing —
  // and the real one is then held until the process dies.
  assert.equal(pool.issued.length, 1, 'releasing must not reach for a second connection')
  assert.match(pool.issued[0]!.queries[1]!, /pg_advisory_unlock/)
  assert.equal(pool.issued[0]!.released, true, 'the connection must go back to the pool')
})

test('a lock somebody else holds is refused, and the connection is not kept', async () => {
  const pool = fakePool({ locked: false })
  const release = await postgresPassLock(pool.sql)('scheduler')

  assert.equal(release, null, 'a held lock must be reported as unavailable')
  assert.equal(pool.issued[0]!.released, true, 'a refused attempt must not leak a connection')
})

test('lock ids are stable, distinct per worker, and inside the range Postgres accepts', () => {
  // Stable: two instances on different builds must land on the same id, or they
  // do not exclude each other at all.
  assert.equal(lockKey('scheduler'), lockKey('scheduler'))
  assert.notEqual(lockKey('scheduler'), lockKey('anchor'))
  assert.notEqual(lockKey('anchor'), lockKey('coach'))

  // Advisory keys are signed 64-bit. Out of range is an error from Postgres,
  // not a silently truncated key.
  for (const name of ['scheduler', 'anchor', 'coach']) {
    const key = lockKey(name)
    assert.ok(key >= -(2n ** 63n) && key < 2n ** 63n, `${name} key out of int8 range`)
  }
})

test('every background worker takes the lock, and releases it in a finally', () => {
  /*
   * The guard is only worth having if each worker actually consults it. This is
   * checked against the source rather than a run because a worker that quietly
   * stopped passing `lock` through would still pass every behavioural test —
   * that is exactly how the in-process boolean came to look sufficient.
   */
  for (const file of ['scheduler.ts', 'anchor.ts', 'coach-brain.ts']) {
    const source = readFileSync(join(JOBS, file), 'utf8')

    assert.match(source, /await options\.lock\(/, `${file} never acquires the lock`)
    assert.match(
      source,
      /if \(release === null\)/,
      `${file} does not stand down when the lock is held`,
    )

    const finallyBlock = source.slice(source.lastIndexOf('} finally {'))
    assert.match(finallyBlock, /await release\(\)/, `${file} can leak the lock on an error path`)
    assert.ok(
      finallyBlock.indexOf('await release()') < finallyBlock.indexOf('running = false'),
      `${file} must release the shared lock before clearing its local one`,
    )
  }
})

test('a held lock stops the pass before it pays to upload anything', async () => {
  /*
   * The behavioural half. Everything above proves the lock works and that the
   * workers mention it; this proves what the lock is for.
   *
   * The expensive step in a scheduler pass is `putSnapshot`, which uploads to
   * 0G Storage and is paid for. It happens before the snapshot row is written,
   * so a duplicate cannot be caught after the fact by a unique index — by then
   * it has already been bought. Standing down has to happen before the upload,
   * and this counts uploads to say whether it did.
   */
  const client = await PGlite.create()

  try {
    const MIGRATIONS = join(import.meta.dirname, '..', 'drizzle')
    for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
      for (const stmt of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
        if (stmt.trim()) await client.exec(stmt.trim())
      }
    }

    const db = drizzle(client, { schema }) as unknown as Database
    await db.insert(schema.users).values({ phone: '+919800000001', sex: 'male', ageYears: 30 })

    let uploads = 0
    const storage = {
      putSnapshot: async () => {
        uploads += 1
        return { rootHashes: ['0xabc'], txHashes: ['0xdef'], bytes: 10, fragmented: false }
      },
    }

    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

    const held = startScheduler({
      db,
      storage: storage as never,
      masterSeed: '0x' + '11'.repeat(32),
      logger: logger as never,
      lock: async () => null,
    })
    held.stop()

    const skipped = await held.runOnce()
    assert.deepEqual(skipped, { attempted: 0, succeeded: 0, failed: 0 })
    assert.equal(uploads, 0, 'a pass that stood down must not have paid for an upload')
    assert.equal((await db.select().from(schema.snapshots)).length, 0)

    // And the same user is still waiting, not skipped — the other instance is
    // the one doing them, and if it died the next tick picks them up.
    let released = 0
    const free = startScheduler({
      db,
      storage: storage as never,
      masterSeed: '0x' + '11'.repeat(32),
      logger: logger as never,
      lock: async () => async () => {
        released += 1
      },
    })
    free.stop()

    const ran = await free.runOnce()
    assert.equal(ran.attempted, 1, 'the work was queued the whole time')
    assert.equal(uploads, 1, 'and gets done exactly once when the lock is free')
    assert.equal(released, 1, 'the lock must be given back after a successful pass')
  } finally {
    await client.close()
  }
})
