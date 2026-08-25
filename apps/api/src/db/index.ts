/**
 * Database connection.
 *
 * Postgres is the hot path. Reads and writes here are synchronous with the
 * request; 0G Storage snapshotting is a background job. The UI must never wait
 * on object storage or a chain.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

export type Database = ReturnType<typeof createDb>['db']

export function createDb(databaseUrl: string, options?: { max?: number }) {
  const max = options?.max ?? 10

  /*
   * The background workers hold one connection out of this pool for the
   * duration of a pass — an advisory lock has to be taken and released on the
   * same session, so it is reserved rather than borrowed per query.
   *
   * A pool of one therefore has nothing left to serve the pass itself, and the
   * first query after the lock waits for a connection that only the pass can
   * return. It does not error; it stops. Found by pointing the lock test at a
   * pool of one, which is a plausible thing to configure for a small
   * deployment and an unpleasant way to discover this.
   */
  if (max < 2) {
    throw new Error(
      `Database pool max must be at least 2, got ${max}. The background workers reserve one ` +
        'connection for the duration of each pass, so a pool of one deadlocks on itself.',
    )
  }

  const sql = postgres(databaseUrl, {
    max,
    // A health app's writes are small and frequent. Long-lived idle
    // connections cost more than they save.
    idle_timeout: 20,
    connect_timeout: 10,
  })

  const db = drizzle(sql, { schema })

  return { db, sql, close: async () => sql.end({ timeout: 5 }) }
}

export { schema }
