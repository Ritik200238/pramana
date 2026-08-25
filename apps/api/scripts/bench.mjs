/**
 * The query plans, taken rather than reasoned about — and re-takeable.
 *
 * The performance numbers in VERIFICATION.md were measured once, interactively,
 * and then written down. That makes them a claim: nobody reading them can check
 * them, and nothing tells us when a change quietly turns an index scan into a
 * sequential one.
 *
 * This seeds the row counts those numbers were taken at, runs EXPLAIN ANALYZE
 * on the queries the application actually issues, and fails if a plan has
 * degraded into a scan of the whole table.
 *
 * On PGlite, which is PostgreSQL 18 compiled to WebAssembly. The planner is
 * genuine Postgres and so the plan shapes are the real ones; the absolute
 * milliseconds are this machine's, in WASM, and are not a claim about a server.
 * The plan is the durable evidence — a bitmap index scan stays one on hardware.
 *
 *   npm run bench -w @ogt/api
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATIONS = join(import.meta.dirname, '..', 'drizzle')

const db = await PGlite.create()
for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
  for (const stmt of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
    if (stmt.trim()) await db.exec(stmt.trim())
  }
}

let failures = 0

/** The plan, and whether it is the shape we require. */
async function plan(label, sql, { mustUse, mustNotUse = ['Seq Scan'] }) {
  const result = await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`)
  const text = result.rows.map((r) => r['QUERY PLAN']).join('\n')
  const time = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?'

  const used = mustUse.some((needle) => text.includes(needle))
  const banned = mustNotUse.filter((needle) => text.includes(needle))
  const ok = used && banned.length === 0
  if (!ok) failures += 1

  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${label}`)
  console.log(`      ${time} ms · expects ${mustUse.join(' or ')}`)
  if (!ok) {
    console.log(banned.length ? `      found ${banned.join(', ')}` : '      expected access method absent')
    console.log(text.split('\n').map((l) => `      | ${l}`).join('\n'))
  } else {
    console.log(`      | ${text.split('\n')[0]}`)
  }
}

console.log('Seeding. Row counts are the ones the recorded numbers were taken at.')

await db.exec(`
  INSERT INTO users (phone, sex, age_years)
  SELECT '+9190' || lpad(g::text, 8, '0'), 'male', 30 FROM generate_series(1, 201) g;
`)
await db.exec(`
  INSERT INTO user_foods (user_id, name, normalised_name, unit, grams_per_unit,
                          kcal_per_100g, protein_per_100g, carb_per_100g, fat_per_100g, times_logged)
  SELECT u.id,
         'dish ' || g || ' ' || substr(md5(u.id::text || g::text), 1, 6),
         'dish ' || g || ' ' || substr(md5(u.id::text || g::text), 1, 6),
         'katori', 150, 120, 6, 18, 2, (g % 40)
  FROM users u CROSS JOIN generate_series(1, 300) g;
`)

await db.exec(`
  INSERT INTO users (phone, sex, age_years)
  SELECT '+9195' || lpad(g::text, 8, '0'), 'female', 29 FROM generate_series(1, 49799) g;
`)
await db.exec(`
  INSERT INTO snapshots (user_id, root_hashes, tx_hashes, schema_version, bytes, created_at)
  SELECT id, '["0x0"]'::jsonb, '["0x0"]'::jsonb, 1, 512, now() - interval '2 hours'
  FROM users WHERE phone LIKE '+9195%' LIMIT 49045;
`)

await db.exec(`
  INSERT INTO sessions (user_id, token_hash, expires_at)
  SELECT (SELECT id FROM users LIMIT 1), md5(g::text) || md5((g+1)::text), now() + interval '30 days'
  FROM generate_series(1, 5000) g;
`)

await db.exec('ANALYZE;')

const counts = await db.query(`
  SELECT (SELECT count(*) FROM user_foods) AS foods,
         (SELECT count(*) FROM users) AS users,
         (SELECT count(*) FROM snapshots) AS snapshots,
         (SELECT count(*) FROM sessions) AS sessions
`)
const { foods, users, snapshots, sessions } = counts.rows[0]
console.log(`  ${foods} user_foods · ${users} users · ${snapshots} snapshots · ${sessions} sessions`)

const [{ id: someUser }] = (await db.query(`SELECT id FROM users WHERE phone LIKE '+9190%' LIMIT 1`)).rows

await plan(
  'personal food search (ILIKE, ordered by times_logged)',
  `SELECT * FROM user_foods
   WHERE user_id = '${someUser}' AND name ILIKE '%dish 1%'
   ORDER BY times_logged DESC LIMIT 8`,
  { mustUse: ['Index Scan', 'Bitmap Index Scan', 'Index Only Scan'] },
)

await plan(
  'users due for a snapshot (anti join against recent snapshots)',
  `SELECT u.id FROM users u
   WHERE NOT EXISTS (
     SELECT 1 FROM snapshots s
     WHERE s.user_id = u.id AND s.created_at > now() - interval '1 day'
   ) LIMIT 25`,
  // A sequential scan of `users` is legitimate here: the anti join reads most
  // of the table by design. What must not happen is probing `snapshots` per
  // user without an index, so the requirement is on the probe side.
  { mustUse: ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'], mustNotUse: [] },
)

const [{ token_hash: someToken }] = (await db.query('SELECT token_hash FROM sessions LIMIT 1')).rows
await plan(
  'session lookup by token hash (every authenticated request)',
  `SELECT * FROM sessions WHERE token_hash = '${someToken}'`,
  { mustUse: ['Index Scan', 'Index Only Scan'] },
)

await db.close()

console.log(`\n${failures === 0 ? 'All plans are the shape they must be.' : `${failures} plan(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
