/**
 * VERIFICATION.md, checked against the repository it describes.
 *
 * That file exists because a claim without evidence is worth nothing, and it had
 * quietly become an example of the thing it warns about: its reproduction
 * section claimed 362 tests when there were 425 and 108 Foundry tests when there
 * were 113, and omitted six commands that existed. Nobody noticed, because a
 * document does not fail.
 *
 * Hand-maintained mirrors of an authoritative source have accounted for most of
 * the defects in this repository — prices against a catalogue, capabilities
 * against `supported_parameters`, route lists against routes. This one had got
 * into the file whose entire purpose is being trustworthy.
 *
 * So the commands it advertises are checked against the scripts that exist, and
 * the counts against the suites that produce them.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

function ledger(): string {
  return readFileSync(join(ROOT, 'VERIFICATION.md'), 'utf8')
}

/** Every script name declared anywhere in the workspace, by package. */
function scripts(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()

  const manifests = [
    join(ROOT, 'package.json'),
    ...['api', 'web'].map((a) => join(ROOT, 'apps', a, 'package.json')),
    ...['core', 'og', 'contracts'].map((p) => join(ROOT, 'packages', p, 'package.json')),
  ]

  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      name?: string
      scripts?: Record<string, string>
    }
    found.set(manifest.name ?? 'root', new Set(Object.keys(manifest.scripts ?? {})))
  }

  return found
}

test('every command the ledger advertises actually exists', () => {
  const declared = scripts()
  const missing: string[] = []

  /*
   * Matches the two shapes the file uses: a workspace command and a root one.
   * A command that names a package we do not have is as broken as a script that
   * does not exist, so the package is checked too.
   */
  for (const [, script, pkg] of ledger().matchAll(
    /^npm run ([a-z:]+)(?: -w (@ogt\/[a-z]+))?/gm,
  )) {
    const owner = pkg ?? 'ogt'
    if (script === undefined) continue
    const names = declared.get(owner)

    if (!names) missing.push(`${script} — no package ${owner}`)
    else if (!names.has(script)) missing.push(`${script} — not a script in ${owner}`)
  }

  assert.deepEqual(missing, [], 'the ledger advertises commands that do not exist')
})

test('the ledger advertises the commands that matter', () => {
  /*
   * The inverse, and the one that actually caught something: a live check
   * nobody is told about might as well not exist. Only commands that verify a
   * claim are required here — `dev`, `build` and `typecheck` are not evidence.
   */
  const text = ledger()
  const required = [
    'evidence',
    'bench',
    'test:compute',
    'test:storage',
    'test:relayed',
    'test:pipeline',
    'test:live',
    'test:fork',
    'test:locks',
    'preflight',
  ]

  const undocumented = required.filter((script) => !text.includes(script))
  assert.deepEqual(undocumented, [], 'a verification command nobody is told about is not evidence')
})

test('the test counts in the ledger match the suites that produce them', () => {
  /*
   * Derived from the files rather than trusted, because the number in that
   * document is the first thing a reader checks and the last thing anybody
   * remembers to update.
   *
   * Counted as `test(` and `it(` declarations, which is what the runners count.
   * The assertion is a floor rather than an exact match: a claim of 425 is
   * dishonest if there are 400, and merely stale if there are 460.
   */
  const suites: Record<string, string> = {
    core: join(ROOT, 'packages', 'core', 'tests'),
    og: join(ROOT, 'packages', 'og', 'tests'),
    api: join(ROOT, 'apps', 'api', 'tests'),
    web: join(ROOT, 'apps', 'web', 'tests'),
  }

  let counted = 0
  for (const dir of Object.values(suites)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
      const source = readFileSync(join(dir, entry.name), 'utf8')
      counted += (source.match(/^\s*(?:test|it)\(/gm) ?? []).length
    }
  }

  const claimed = Number(/npm test --workspaces\s+#\s*(\d+) tests/.exec(ledger())?.[1] ?? 0)

  assert.ok(claimed > 0, 'the ledger must state how many tests there are')
  assert.ok(
    counted >= claimed,
    `the ledger claims ${claimed} tests; ${counted} are declared`,
  )
})

test('a NOT VERIFIED marker is never left beside a passing claim', () => {
  /*
   * The one way this file could mislead while every other check passes: a gap
   * gets closed, the work is celebrated somewhere in the document, and the
   * marker above it is never removed. A reader would take the harsher reading,
   * which is the safe direction — but the opposite mistake is fatal, so the
   * headings are held to a shape where both cannot be true at once.
   */
  const text = ledger()

  for (const [heading] of text.matchAll(/^### .*$/gm)) {
    const verified = /VERIFIED LIVE|— VERIFIED|CLOSED/.test(heading)
    const not = /NOT VERIFIED/.test(heading)
    assert.ok(!(verified && not), `a heading claims both at once: ${heading}`)
  }
})
