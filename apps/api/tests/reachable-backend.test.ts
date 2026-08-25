/**
 * Capabilities the product can actually reach.
 *
 * The most expensive defect in this repository is not broken code. It is
 * correct, tested code that nothing calls, and it has appeared often enough to
 * be a pattern rather than a run of bad luck: the anchor worker, the coach
 * contract, the blood-report screen, the facts list, `snapshotAt`, and — twice
 * in one sitting — the wallet-paid inference path, which was verified live
 * against a real provider while no deployment could select it and then, once it
 * could, would have named a model the provider had never heard of.
 *
 * Every one of those had passing tests. Coverage says nothing about reachability.
 *
 * So this asks the question directly: for each capability `packages/og` offers,
 * does anything in the product use it? The answer being "no" is allowed, and it
 * has to be written down with a reason — which turns a silent gap into a
 * decision somebody made.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const OG_SRC = join(ROOT, 'packages', 'og', 'src')

/**
 * Exports that are deliberately not called by the product, and why.
 *
 * Kept as reasons rather than a count, so adding one is a sentence somebody has
 * to write rather than a number that quietly moves.
 */
const NOT_CALLED_BY_THE_PRODUCT: Record<string, string> = {
  // Contract interfaces, for anybody reading the chain without this API.
  ANCHOR_ABI: 'published for external readers',
  COACH_ABI: 'published for external readers',
  COACH_SIGNATURE_TTL_SECONDS: 'published alongside the ABI',

  // Reached through `instanceof` or as types, which a name scan cannot see.
  InsufficientBalanceError: 'thrown and caught by instanceof',
  InvalidPhraseError: 'thrown and caught by instanceof',
  TranscriptionError: 'thrown and caught by instanceof',
  BalanceSchema: 'type-level',
  TraceSchema: 'type-level',

  /*
   * The browser holds its own key derivation, because packages/og is written
   * for Node and the phrase must be generated where it will never leave. The
   * two must agree exactly, and a test asserts that they do — see
   * apps/web/tests/custody-key.test.ts for the fixed vector both are held to.
   */
  createSelfCustodyKey: 'server-side twin of the browser derivation; both pinned to one vector',
  normalisePhrase: 'same',
  phraseMatchesAddress: 'available for a server-side check nothing needs yet',

  // Small helpers used inside their own module and exported for tests.
  NEURON_PER_OG: 'unit constant',
  PAYMENT_LAYER: 'documentation constant',
  parseOg: 'used by formatting helpers',
  formatCharge: 'used by formatting helpers',
  estimateCostNeuron: 'budgeting helper, not on any request path',
  isInsufficientBalance: 'used by the balance watcher through its error type',
  readCostNeuron: 'used inside complete()',
  readReceipt: 'used inside complete(), which every model path calls',
  readTrace: 'used by readReceipt',
  clientModelChain: 'used inside complete() to find the chain a client carries',
  readService: 'used inside listChatServices()',
  isProvable: 'used by describeReceipt',
  isTrustworthy: 'used by describeReceipt',
  describeReceipt: 'renders a receipt for the proof panel via the API layer',
  serviceAttestation: 'used by the live compute test; the proof panel reads the Router shape',
  serviceChain: 'used by createBrokerClient to attach the chain to the client',
}

function exportedNames(source: string): string[] {
  return Array.from(
    source.matchAll(/^export (?:async )?(?:function|const|class) ([A-Za-z_][A-Za-z0-9_]*)/gm),
    (match) => match[1]!,
  )
}

function readAll(dir: string, skip: (path: string) => boolean): string {
  let combined = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) combined += readAll(path, skip)
    else if (/\.tsx?$/.test(entry.name) && !skip(path)) combined += readFileSync(path, 'utf8')
  }
  return combined
}

test('every capability packages/og offers is either used or accounted for', () => {
  const declared = new Map<string, string>()

  for (const entry of readdirSync(OG_SRC, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name === 'index.ts') continue
    const source = readFileSync(join(OG_SRC, entry.name), 'utf8')
    for (const name of exportedNames(source)) declared.set(name, entry.name)
  }

  // A scan that finds nothing would pass while checking nothing, which is the
  // shape of guard this file exists to prevent.
  assert.ok(declared.size > 30, `expected many exports, found ${declared.size}`)

  const product = readAll(join(ROOT, 'apps', 'api', 'src'), () => false) +
    readAll(join(ROOT, 'apps', 'web', 'src'), () => false)

  const unreachable: string[] = []
  for (const [name, file] of declared) {
    if (name in NOT_CALLED_BY_THE_PRODUCT) continue
    if (!new RegExp(`\\b${name}\\b`).test(product)) unreachable.push(`${name} (${file})`)
  }

  assert.deepEqual(
    unreachable,
    [],
    'built, tested, and unreachable — either wire it or record why not',
  )
})

test('the exemption list refers to things that still exist', () => {
  // An exemption for a deleted export is a sentence pretending to be a decision.
  const all = new Set<string>()
  for (const entry of readdirSync(OG_SRC, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    for (const name of exportedNames(readFileSync(join(OG_SRC, entry.name), 'utf8'))) {
      all.add(name)
    }
  }

  const stale = Object.keys(NOT_CALLED_BY_THE_PRODUCT).filter((name) => !all.has(name))
  assert.deepEqual(stale, [])
})

test('the broker client is given what it needs to name the right model', () => {
  /*
   * The specific instance that got past everything else. `complete` resolves
   * models from the task chains, which name Router models; a provider reached
   * directly serves its own. The fix lived in an option every call site had to
   * remember, and none did.
   *
   * The chain travels with the client now, so this asserts the one line that
   * puts it there.
   */
  const server = readFileSync(join(ROOT, 'apps', 'api', 'src', 'server.ts'), 'utf8')

  assert.match(
    server,
    /createBrokerClient\(\{[\s\S]*?service,/,
    'the broker client must be handed the service, or it carries no chain',
  )
})
