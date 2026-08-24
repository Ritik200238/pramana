/**
 * "Export everything, free, forever" is a promise, and promises drift.
 *
 * The old check listed eleven table names by hand, which meant it only ever
 * verified what somebody had remembered to add to it. By the time a sweep
 * compared the export against the schema there were nineteen tables and seven
 * were absent — including `inference_usage`, the record of every computation
 * performed on that person's data. The app shows those as receipts and makes a
 * claim about them, so an export missing them handed somebody their meals while
 * keeping the evidence about how those meals were read.
 *
 * This derives the answer from the schema instead. Every table is either
 * exported or listed below with a reason, so a new one cannot be added without
 * somebody deciding which it is.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8')
}

/**
 * Tables deliberately absent from an export, each with the reason.
 *
 * The bar is not "is it about the user" — most of these are. It is whether
 * handing it to somebody in a file they may forward does them more good than
 * harm.
 */
const DELIBERATELY_EXCLUDED: Record<string, string> = {
  sessions:
    'live authentication material. An export is a file people email to themselves; ' +
    'session hashes do not belong in one.',
  otp_challenges:
    'hashes of one-time codes, for the same reason. They also expire in minutes and ' +
    'describe nothing about the person.',
  idempotency_keys:
    'plumbing that prevents duplicate writes. It holds stored responses rather than ' +
    'anything the user told us.',
  global_foods:
    'the shared food database. It is not theirs, and it is the same for everybody.',
}

function schemaTables(): Array<{ prop: string; name: string }> {
  const schema = read('db', 'schema.ts')
  const found: Array<{ prop: string; name: string }> = []

  // `export const meals = pgTable('meals', {` — and the two-line form.
  const pattern = /export const (\w+) = pgTable\(\s*'?([a-z_]*)'?/g
  for (const match of schema.matchAll(pattern)) {
    let name = match[2]
    if (!name) {
      // The name is on the following line in the multi-line form.
      const after = schema.slice(match.index ?? 0, (match.index ?? 0) + 200)
      name = /pgTable\(\s*\n\s*'([a-z_]+)'/.exec(after)?.[1] ?? ''
    }
    if (name) found.push({ prop: match[1]!, name })
  }

  return found
}

test('the schema is readable and has the tables we expect', () => {
  const tables = schemaTables()
  // If the parse breaks, every check below passes for the wrong reason.
  assert.ok(tables.length >= 15, `parsed only ${tables.length} tables`)
  assert.ok(tables.some((t) => t.name === 'meals'))
  assert.ok(tables.some((t) => t.name === 'inference_usage'))
})

test('every table is either exported or excluded on purpose', () => {
  const exportSource = read('routes', 'export.ts')
  const unaccounted: string[] = []

  for (const { prop, name } of schemaTables()) {
    if (name in DELIBERATELY_EXCLUDED) continue
    if (new RegExp(`\\b${prop}\\b`).test(exportSource)) continue
    unaccounted.push(name)
  }

  assert.deepEqual(
    unaccounted,
    [],
    'add these to the export, or to DELIBERATELY_EXCLUDED with a reason',
  )
})

test('the exclusions are real tables, not stale names', () => {
  // An exclusion for a table that no longer exists silently widens the rule
  // and would let a genuinely missing table slip through under an old name.
  const names = new Set(schemaTables().map((t) => t.name))

  for (const excluded of Object.keys(DELIBERATELY_EXCLUDED)) {
    assert.ok(names.has(excluded), `${excluded} is excluded but is not in the schema`)
  }
})

test('no exclusion is left without a reason', () => {
  for (const [table, reason] of Object.entries(DELIBERATELY_EXCLUDED)) {
    assert.ok(reason.length > 40, `${table} needs a real reason, not a placeholder`)
  }
})

test('the attestation receipts are in the export', () => {
  // The specific omission that prompted all of this. The product shows these on
  // screen as evidence for its privacy claim; keeping them out of the export
  // would mean the evidence is ours and the data is theirs.
  const exportSource = read('routes', 'export.ts')

  assert.match(exportSource, /inferenceUsage/, 'the receipts must be queried')
  assert.match(exportSource, /computations:/, 'and appear in the payload')
  assert.match(exportSource, /attestationProvider|provider: row\./, 'including who ran it')
})

test('no authentication material reaches the export', () => {
  // The other direction, and the more dangerous one. An export is a file people
  // forward; a session token in it is a credential in somebody's inbox.
  const exportSource = read('routes', 'export.ts')

  for (const forbidden of ['tokenHash', 'codeHash', 'sessions)', 'otpChallenges']) {
    assert.doesNotMatch(
      exportSource,
      new RegExp(forbidden.replace(')', '\\)')),
      `${forbidden} must never be exported`,
    )
  }
})
