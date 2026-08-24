/**
 * The schema must describe what the code does, not what somebody meant to do.
 *
 * `users.record_pub_key` carried a confident comment and was written by
 * nothing. Being null for every user silently disabled 0G Storage, on-chain
 * anchoring and coach minting all at once, and an empty work queue reads
 * exactly like a finished one. The schema is where a reader goes to find out
 * what exists, so a column that describes an intention is worse than no column.
 *
 * Columns nothing writes are now marked NOT YET WRITTEN. This keeps that
 * marking honest in both directions: a marked column somebody starts writing
 * must lose the marker, and it verifies the marker matches real columns rather
 * than drifting into decoration.
 *
 * Written as its own file, and by hand rather than generated, because the last
 * three attempts to add a pattern-matching test through a shell heredoc were
 * corrupted by escaping — once into a regex containing a control character that
 * matched nothing and passed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8')
}

/** Strip comments, so a column named in a note does not count as a write. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Every file that could plausibly write a user or meal column. */
const WRITERS = [
  ['services', 'record-key.ts'],
  ['services', 'meal-log.ts'],
  ['services', 'corrections.ts'],
  ['services', 'auth.ts'],
  ['services', 'streaks.ts'],
  ['services', 'food-library.ts'],
  ['services', 'proactive.ts'],
  ['jobs', 'snapshot.ts'],
  ['jobs', 'coach-brain.ts'],
  ['jobs', 'anchor.ts'],
  ['jobs', 'scheduler.ts'],
  ['routes', 'users.ts'],
  ['routes', 'meals.ts'],
  ['routes', 'coach.ts'],
  ['routes', 'day.ts'],
  ['routes', 'auth.ts'],
]

/** Column properties sitting under a NOT YET WRITTEN notice. */
function declaredUnwritten(schema: string): string[] {
  const lines = schema.split('\n')
  const found = new Set<string>()

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.includes('NOT YET WRITTEN')) continue

    // Walk to the end of the comment the notice lives in, then take the run of
    // column declarations directly beneath it. A fixed-size window was tried
    // first and swallowed the next field group, which made the check report
    // columns the notice never covered.
    let cursor = index
    while (cursor < lines.length && !lines[cursor]!.includes('*/')) cursor += 1
    cursor += 1

    for (; cursor < lines.length; cursor += 1) {
      const match = /^ {4}(\w+): +\w+\('([a-z0-9_]+)'/.exec(lines[cursor]!)
      if (!match) break
      found.add(match[1]!)
    }
  }

  return [...found]
}

test('the NOT YET WRITTEN marker matches real columns', () => {
  const unwritten = declaredUnwritten(read('db', 'schema.ts'))

  // If this ever finds nothing, the marker has been renamed or removed and
  // every check below would pass vacuously.
  assert.ok(unwritten.length > 0, 'the marker must match some columns to mean anything')
})

test('nothing writes a column the schema calls unwritten', () => {
  const unwritten = declaredUnwritten(read('db', 'schema.ts'))
  const sources = WRITERS.map((parts) => code(read(...parts))).join('\n')

  const contradicted = unwritten.filter((column) => {
    // A write looks like `column: value` inside an insert or update.
    const assignment = new RegExp(`\\b${column}:\\s`)
    return assignment.test(sources)
  })

  assert.deepEqual(
    contradicted,
    [],
    'these are marked NOT YET WRITTEN but something assigns them — update the schema comment',
  )
})

test('the record key comment does not claim we cannot read it', () => {
  // It used to say "We never hold the matching private key". That became false
  // the moment the key was derived from a seed we hold, and it is the sentence
  // somebody would cite when deciding what the product may promise.
  const schema = read('db', 'schema.ts')
  const claim = /never hold the matching private key/i

  assert.doesNotMatch(
    schema,
    claim,
    'the derivation is custodial; the schema must not claim otherwise',
  )
})

test('the anchor address is stored, because it is what makes seed drift visible', () => {
  // Recomputable, and kept anyway. Without a stored witness, a rotated or
  // mistyped seed moves every derivation and orphans the record with nothing
  // failing.
  const source = code(read('services', 'record-key.ts'))

  assert.match(source, /anchorAddress/, 'the address must be recorded')
  assert.match(source, /SeedDriftError/, 'and a mismatch must be refused, not written over')
})
