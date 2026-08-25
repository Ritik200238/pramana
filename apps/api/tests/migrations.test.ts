/**
 * Every migration, applied to a database that already has somebody in it.
 *
 * The harness applies migrations to an empty database, which is the one case
 * that is never the case in production. A migration that adds a NOT NULL column
 * without a default, drops one, or rewrites a table is fine against nothing and
 * destroys a health record against something — and the first time anybody finds
 * out is the deploy.
 *
 * So this seeds a person after the first migration and then applies the rest one
 * at a time, checking after each that they are still there and still themselves.
 * The list comes from the directory rather than from a list here, so a migration
 * added tomorrow is covered without anybody remembering.
 *
 * Today's nine are safe by inspection: the three `ADD COLUMN ... NOT NULL` all
 * carry defaults, and nothing drops or renames. This is not for today's nine.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATIONS = join(import.meta.dirname, '..', 'drizzle')

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

async function apply(db: PGlite, file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) await db.exec(statement.trim())
  }
}

/** A person, in the shape the very first migration allows. */
const PHONE = '+919876543210'

async function seedPerson(db: PGlite): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (phone, sex, age_years) VALUES ($1, 'male', 28) RETURNING id`,
    [PHONE],
  )
  return result.rows[0]!.id
}

test('every migration is safe to apply to a database that already has data', async () => {
  const files = migrationFiles()

  // A parse that finds nothing would make everything below pass vacuously,
  // which is the shape of guard this repository has shipped before.
  assert.ok(files.length >= 9, `expected the migrations to be found, got ${files.length}`)

  const db = await PGlite.create()

  try {
    await apply(db, files[0]!)

    /*
     * Seeded immediately, so every later migration runs against a populated
     * table rather than an empty one. That difference is the entire point:
     * `ADD COLUMN ... NOT NULL` without a default succeeds on zero rows and
     * fails on one.
     */
    const userId = await seedPerson(db)

    await db.query(
      `INSERT INTO meals (user_id, kcal, protein_g, carb_g, fat_g, confidence, source)
       VALUES ($1, 520, 24, 60, 18, 'confirmed', 'photo')`,
      [userId],
    )
    await db.query(
      `INSERT INTO chat_messages (user_id, role, content) VALUES ($1, 'user', $2)`,
      [userId, 'slept badly all week'],
    )

    for (const file of files.slice(1)) {
      try {
        await apply(db, file)
      } catch (error) {
        assert.fail(
          `${file} cannot be applied to a database with rows in it: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }

      // Still there, and still theirs, after every single step.
      const people = await db.query<{ id: string; phone: string }>(
        'SELECT id, phone FROM users',
      )
      assert.equal(people.rows.length, 1, `${file} lost the user`)
      assert.equal(people.rows[0]!.id, userId, `${file} changed the user's id`)
      assert.equal(people.rows[0]!.phone, PHONE, `${file} changed the user's phone`)

      const meals = await db.query<{ kcal: number }>('SELECT kcal FROM meals')
      assert.equal(meals.rows.length, 1, `${file} lost a meal`)
      assert.equal(Number(meals.rows[0]!.kcal), 520, `${file} altered a meal`)

      // R6 — nothing said to us is ever thrown away, including by a migration.
      const said = await db.query<{ content: string }>('SELECT content FROM chat_messages')
      assert.equal(said.rows.length, 1, `${file} lost what somebody said`)
      assert.equal(said.rows[0]!.content, 'slept badly all week')
    }
  } finally {
    await db.close()
  }
})

test('applying the migrations twice is not a disaster', async () => {
  /*
   * Deploys get retried, and a half-applied migration run followed by a full one
   * is a normal Tuesday. Drizzle tracks what has run, but the raw files are what
   * this suite and several scripts apply, so it is worth knowing what a second
   * pass does.
   *
   * The expectation is not that it succeeds — `CREATE TABLE` will object — but
   * that it fails loudly rather than damaging what is there.
   */
  const files = migrationFiles()
  const db = await PGlite.create()

  try {
    for (const file of files) await apply(db, file)
    const userId = await seedPerson(db)

    let secondPassFailed = false
    try {
      for (const file of files) await apply(db, file)
    } catch {
      secondPassFailed = true
    }

    assert.ok(secondPassFailed, 'a second raw pass should object rather than proceed silently')

    // And the person is untouched by the attempt.
    const people = await db.query<{ id: string }>('SELECT id FROM users')
    assert.equal(people.rows.length, 1)
    assert.equal(people.rows[0]!.id, userId)
  } finally {
    await db.close()
  }
})

test('no migration drops or renames anything', () => {
  /*
   * A blunt rule, deliberately. Dropping a column is how a health record loses
   * a year of somebody's life, and renaming one is how a deploy takes the app
   * down between the migration and the code that expects the new name.
   *
   * If a migration ever genuinely needs to, this test should be the argument
   * about it rather than something discovered afterwards.
   */
  const offences: string[] = []

  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')

    for (const pattern of [/DROP\s+TABLE/i, /DROP\s+COLUMN/i, /RENAME/i]) {
      if (pattern.test(sql)) offences.push(`${file}: ${pattern.source}`)
    }

    /*
     * A NOT NULL column with no default is the classic one. It is fine on an
     * empty table and fails on a populated one, so it passes review, passes the
     * test suite, and fails on the deploy.
     */
    for (const match of sql.matchAll(/ADD COLUMN[^;]*/gi)) {
      const clause = match[0]
      if (/NOT NULL/i.test(clause) && !/DEFAULT/i.test(clause)) {
        offences.push(`${file}: NOT NULL without a default — ${clause.slice(0, 60)}`)
      }
    }
  }

  assert.deepEqual(offences, [])
})
