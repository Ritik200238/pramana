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


test('the Foundry count in the ledger matches the contracts', () => {
  /*
   * The other number a reader checks. Counted from the test contracts rather
   * than trusted, for the same reason as the suite total above: it is the first
   * thing somebody verifies and the last thing anybody remembers to update.
   */
  const testDir = join(ROOT, 'packages', 'contracts', 'test')

  let counted = 0
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.t.sol')) continue
    const source = readFileSync(join(testDir, entry.name), 'utf8')
    counted += (source.match(/^\s*function test/gm) ?? []).length
  }

  const claimed = Number(/forge test\s+#\s*(\d+) tests/.exec(ledger())?.[1] ?? 0)

  assert.ok(claimed > 0, 'the ledger must state how many contract tests there are')
  assert.ok(
    counted >= claimed,
    `the ledger claims ${claimed} Foundry tests; ${counted} are declared`,
  )
})

/*
 * The README gets the same treatment as the ledger, and for a better reason: it
 * is the first thing anybody reads and the last thing anybody updates.
 *
 * It claimed 113 tests when there were 703, and did not mention the web app at
 * all — a number written down once, six times out of date, sitting under a
 * heading that said "Current state". The ledger had a test for exactly this and
 * the README did not, which is the whole reason it drifted.
 */

function readme(): string {
  return readFileSync(join(ROOT, 'README.md'), 'utf8')
}

test('the README test counts match the suites that produce them', () => {
  const dirs: Record<string, string> = {
    core: join(ROOT, 'packages', 'core', 'tests'),
    og: join(ROOT, 'packages', 'og', 'tests'),
    api: join(ROOT, 'apps', 'api', 'tests'),
    web: join(ROOT, 'apps', 'web', 'tests'),
  }

  const actual: Record<string, number> = {}
  for (const [name, dir] of Object.entries(dirs)) {
    let n = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
      n += (readFileSync(join(dir, entry.name), 'utf8').match(/^\s*(?:test|it)\(/gm) ?? []).length
    }
    actual[name] = n
  }

  let contracts = 0
  const solDir = join(ROOT, 'packages', 'contracts', 'test')
  for (const entry of readdirSync(solDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.t.sol')) continue
    contracts += (readFileSync(join(solDir, entry.name), 'utf8').match(/^\s*function test/gm) ?? []).length
  }
  actual.contracts = contracts

  const row = /\| Tests \| \*\*(\d+) passing\*\* — (.+?) \|/.exec(readme())
  assert.ok(row, 'the README must state how many tests there are')

  // Each suite named in the row, checked against the files. A floor, like the
  // ledger: claiming fewer than exist is stale, claiming more is dishonest.
  const wrong: string[] = []
  for (const [, count, name] of row[2]!.matchAll(/(\d+)\s+([a-z]+)/g)) {
    const have = actual[name!]
    if (have === undefined) wrong.push(`${name} — no such suite`)
    else if (Number(count) > have) wrong.push(`${name}: claims ${count}, ${have} exist`)
  }
  assert.deepEqual(wrong, [], 'the README claims tests that do not exist')

  const total = Object.values(actual).reduce((a, b) => a + b, 0)
  assert.ok(
    Number(row[1]) <= total,
    `the README claims ${row[1]} tests; ${total} are declared`,
  )
})

test('the README does not promise the absence of a feature that exists', () => {
  /*
   * "No wallet, no gas, no seed phrase — ever" was true the day it was written
   * and false the day self-custody shipped, which is a BIP-39 phrase generated
   * on the device. Nothing failed: a sentence in a document cannot.
   *
   * The check is narrow on purpose — an absolute claim about a capability, held
   * against whether that capability is in the tree.
   */
  const text = readme()

  const custody = join(ROOT, 'apps', 'web', 'src', 'lib', 'custody.ts')
  let hasCustody = true
  try {
    readFileSync(custody, 'utf8')
  } catch {
    hasCustody = false
  }

  if (!hasCustody) return

  for (const forbidden of ['seed phrase — ever', 'no seed phrase, ever', 'never a seed phrase']) {
    assert.ok(
      !text.toLowerCase().includes(forbidden.toLowerCase()),
      `the README rules out a seed phrase while custody.ts generates one: "${forbidden}"`,
    )
  }
})
