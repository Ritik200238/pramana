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
  const sql = postgres(databaseUrl, {
    max: options?.max ?? 10,
    // A health app's writes are small and frequent. Long-lived idle
    // connections cost more than they save.
    idle_timeout: 20,
    connect_timeout: 10,
  })

  const db = drizzle(sql, { schema })

  return { db, sql, close: async () => sql.end({ timeout: 5 }) }
}

export { schema }
