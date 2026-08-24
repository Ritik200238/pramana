/**
 * The example env file, checked against the configuration it documents.
 *
 * A required variable missing from `.env.example` is a boot failure with no
 * guidance: the server refuses to start and the person deploying it has nothing
 * to read. A documented variable the config never reads is worse in a quieter
 * way — somebody sets it, nothing happens, and they go looking for a bug
 * somewhere real.
 *
 * Both are the defect this repository keeps producing: something maintained by
 * hand that mirrors something authoritative, drifting in silence. So this reads
 * the list out of config.ts rather than restating it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = join(import.meta.dirname, '..')

const config = readFileSync(join(HERE, 'src', 'config.ts'), 'utf8')
const example = readFileSync(join(HERE, '.env.example'), 'utf8')

/**
 * Every variable the config declares, and whether it may be left unset.
 *
 * Declarations span several lines — `NAME: z` then `.string()` then
 * `.optional()` — so this reads from one declaration to the next rather than to
 * the end of a line. A single-line pattern was tried first and reported five
 * variables as undeclared that were merely written across lines.
 */
function declared(): Array<{ name: string; optional: boolean }> {
  const names = [...config.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)]

  return names.map((match, index) => {
    const start = match.index ?? 0
    const end = names[index + 1]?.index ?? config.length
    const body = config.slice(start, end)
    return {
      name: match[1]!,
      optional: body.includes('.optional()') || body.includes('.default('),
    }
  })
}

/**
 * Names the example file mentions as settings.
 *
 * Matched by scanning lines rather than by building a pattern per name.
 * Assembling one turned out to be a reliable way to introduce an escaping
 * mistake that silently matches nothing — which is exactly the failure this
 * file is about.
 */
function documented(): Set<string> {
  const found = new Set<string>()

  for (const line of example.split('\n')) {
    const trimmed = line.replace(/^#\s*/, '').trim()
    const match = /^([A-Z][A-Z0-9_]+)=/.exec(trimmed)
    if (match) found.add(match[1]!)
  }

  return found
}

test('both files parse into something worth comparing', () => {
  const vars = declared()
  const docs = documented()

  // If either parse breaks, every check below passes for the wrong reason.
  assert.ok(vars.length >= 10, `parsed only ${vars.length} config variables`)
  assert.ok(docs.size >= 10, `parsed only ${docs.size} documented variables`)
  assert.ok(vars.some((v) => v.name === 'DATABASE_URL' && !v.optional))
  assert.ok(vars.some((v) => v.name === 'OG_ANCHOR_ADDRESS' && v.optional))
  assert.ok(docs.has('OG_ANCHOR_ADDRESS'), 'the documented-name parse is broken')
})

test('every configuration variable appears in .env.example', () => {
  const docs = documented()
  const undocumented = declared()
    .filter(({ name }) => !docs.has(name))
    .map(({ name, optional }) => `${name}${optional ? ' (optional)' : ' (REQUIRED)'}`)

  assert.deepEqual(undocumented, [], 'document these in .env.example')
})

test('.env.example documents nothing the config ignores', () => {
  const known = new Set(declared().map((v) => v.name))
  const stale = [...documented()].filter((name) => !known.has(name))

  // Setting one of these does nothing at all, which sends somebody hunting for
  // a bug that is not there.
  assert.deepEqual(stale, [], 'these are documented but never read')
})

test('no real secret is committed as an example value', () => {
  // An example file is the easiest place for a working key to end up.
  assert.doesNotMatch(example, /=sk-[A-Za-z0-9]{8,}/, 'a live inference key is in .env.example')
  assert.doesNotMatch(example, /=mk-[A-Za-z0-9]{8,}/, 'a live management key is in .env.example')
  assert.doesNotMatch(example, /=0x[0-9a-fA-F]{64}/, 'a real private key is in .env.example')
})
