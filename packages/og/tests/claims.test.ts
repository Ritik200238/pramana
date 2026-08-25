/**
 * What the product is allowed to say about attestation.
 *
 * 0G's documentation is precise about this and our copy was not. `verify_tee`
 * asks the Router to fetch the provider's TEE signature, look the signer up on
 * chain, check it, and return one boolean. The signature itself is not returned.
 * So `tee_verified: true` means "the Router says it verified this" — traceable
 * to a named provider and a request id, and still somebody else's assertion.
 *
 * We were telling people "Nobody — including us — could read them", which
 * overstated the evidence in two directions at once. The Router relays the
 * prompt, so it is not sealed from everyone in transit. And records are
 * encrypted to a key we currently hold on the user's behalf, so we can read
 * them.
 *
 * A privacy claim that overstates its evidence is worth less than a smaller one
 * that holds, because the first thing a sceptical reader does is check.
 *
 * Source: 0G docs, Router → Verifiable Execution, "Trust model".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeReceipt } from '../src/attestation.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Everywhere a claim about attestation can reach a person. */
const USER_FACING = [
  ['packages', 'og', 'src', 'attestation.ts'],
  ['apps', 'api', 'src', 'routes', 'coach.ts'],
  ['apps', 'web', 'src', 'screens', 'SignIn.tsx'],
  ['apps', 'web', 'src', 'screens', 'You.tsx'],
]

function surfaces(): string {
  return USER_FACING.map((parts) => readFileSync(join(ROOT, ...parts), 'utf8')).join('\n')
}

test('nothing claims that we cannot read a user’s data', () => {
  // False twice over: the Router relays the plaintext, and the record key is
  // ours today. Whichever way custody goes later, this sentence needs evidence
  // before it can be said.
  assert.doesNotMatch(
    surfaces(),
    /nobody\s*[—-]?\s*including us/i,
    'this claims more than the attestation supports, and more than custody allows',
  )
})

test('a verified receipt does not describe itself as proof we hold', () => {
  const text = describeReceipt({
    requestId: 'req-1',
    provider: '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C',
    model: 'qwen3-vl-30b',
    status: 'verified',
    verifiedAt: new Date().toISOString(),
  })

  // It must name who ran it and say whose check this is.
  assert.match(text, /0G verified/i, 'the reader should know who did the verifying')
  assert.match(text, /not a signature we hold/i, 'and that the signature is not returned')
  assert.match(text, /0xd996/, 'and which provider ran it')
})

test('the trust model is stated where somebody decides whether to believe it', () => {
  const you = readFileSync(join(ROOT, 'apps', 'web', 'src', 'screens', 'You.tsx'), 'utf8')

  // Buried in a source comment is not stated. It has to be on the screen that
  // shows the receipts.
  assert.match(you, /trust-note/, 'the proof screen must carry the explanation')
  assert.match(you, /not the signature|not a proof you can re-run|signature itself/i)
  /*
   * Matched on substance rather than on one phrasing. The original required the
   * exact words "we currently hold", which meant an honest rewording failed
   * while an omission of the consequence would have passed — so this now
   * requires both halves: that we hold the key, and what that means.
   */
  assert.match(you, /key we (currently )?hold/i, 'must not omit that custody is ours by default')
  // Whitespace-tolerant: the sentence wraps across lines in JSX, so matching a
  // single space would fail on a reflow that changed nothing a reader sees.
  assert.match(you, /we\s+can read them/i, 'and must say plainly what that means')

  // And must not describe self-custody as something still to come. It shipped;
  // this sentence was left saying otherwise for a while, on the one screen
  // where being out of date is the same as being untrue.
  assert.doesNotMatch(you, /next thing to change|coming soon/i)
})

test('an unverified state is never described as verified', () => {
  for (const status of ['failed', 'unavailable', 'unrequested'] as const) {
    const text = describeReceipt({
      requestId: null,
      provider: null,
      model: 'qwen3-vl-30b',
      status,
      verifiedAt: new Date().toISOString(),
    })

    assert.doesNotMatch(
      text,
      /sealed hardware.*0G verified/i,
      `a ${status} receipt must not read like a verified one`,
    )
  }
})
