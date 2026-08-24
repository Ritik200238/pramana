/**
 * Migration runner.
 *
 * Separate from the server so schema changes are an explicit, auditable step
 * rather than something that happens silently on deploy. A health database
 * should never be migrated by an autoscaler starting a new instance.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

// max: 1 — migrations must run on a single connection, in order.
const sql = postgres(databaseUrl, { max: 1 })

try {
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
  console.log('Migrations applied.')
} catch (error) {
  console.error('Migration failed:', error)
  process.exitCode = 1
} finally {
  await sql.end()
}
