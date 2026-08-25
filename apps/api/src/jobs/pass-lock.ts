/**
 * One worker pass at a time, across every instance — not just within one.
 *
 * Each worker already refuses to run two passes at once. It does that with a
 * boolean, and that boolean lives in one process. Run two API instances, which
 * is what happens the first time anybody scales past a single container, and
 * both schedulers walk straight through the check.
 *
 * The chain writes survive that on their own: every one carries a deterministic
 * EIP-712 nonce derived from stable data, and the contract rejects a reused
 * one. Snapshotting does not survive it. Two instances see the same users due,
 * both build a snapshot, and both pay to upload it to 0G Storage *before*
 * either writes the row that would have revealed the duplicate. The money is
 * spent by the time anything could notice.
 *
 * A Postgres advisory lock is the smallest correct answer. No table, no
 * migration, and — the part a claim row cannot match — the server drops it by
 * itself when the holder dies, so a pod killed mid-pass blocks nobody.
 *
 * The one way this is commonly got wrong is holding it through a pool: the lock
 * is taken on whichever connection served the query and released on whichever
 * serves the next, which silently never releases. So this reserves a connection
 * for the life of the lock and speaks to that one.
 */

import { createHash } from 'node:crypto'
import type postgres from 'postgres'

/**
 * Acquire the named lock. Resolves to a release function, or to `null` when
 * somebody else holds it and this pass should simply be skipped.
 *
 * A skipped pass is not a failure: the work stays queued and the holder is
 * doing it right now.
 */
export type PassLock = (name: string) => Promise<(() => Promise<void>) | null>

/**
 * Advisory lock ids are signed 64-bit integers, and Postgres has one shared
 * space of them for the whole database. A hash of the worker's name keeps two
 * unrelated workers from colliding into each other's lock, and keeps the id
 * stable across deployments so instances running different builds still
 * exclude one another.
 */
export function lockKey(name: string): bigint {
  return createHash('sha256').update(`ogt:pass-lock:${name}`).digest().readBigInt64BE(0)
}

/**
 * The real thing: one reserved connection, held until release.
 *
 * The key is sent as text and cast in SQL rather than bound as a bigint. The
 * driver has its own opinion about how a JavaScript bigint should be sent, and
 * `pg_try_advisory_lock` has overloads — being explicit here costs nothing and
 * removes the question.
 */
export function postgresPassLock(sql: postgres.Sql<Record<string, unknown>>): PassLock {
  return async (name) => {
    const key = lockKey(name)
    const connection = await sql.reserve()

    let locked = false
    try {
      const [row] = await connection<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${key.toString()}::bigint) as locked
      `
      locked = row?.locked === true
    } catch (error) {
      connection.release()
      throw error
    }

    if (!locked) {
      connection.release()
      return null
    }

    return async () => {
      try {
        await connection`select pg_advisory_unlock(${key.toString()}::bigint)`
      } finally {
        // Even if the unlock fails, the connection must go back. Postgres frees
        // the lock when the session ends regardless.
        connection.release()
      }
    }
  }
}
