/**
 * Wiring tests.
 *
 * These exist because of a specific class of bug that all ten of the fixes in
 * this pass belonged to: code that was written, typed, and tested, but that
 * nothing ever called. A unit test on an orphaned function passes happily
 * while the feature does not exist.
 *
 * So these assert connections rather than behaviour.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8')
}

/** Strip comments — a phrase named in order to forbid it must not count as a use. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

test('R5 — logging a meal creates the user\'s own version of the food', () => {
  // The personal library was permanently empty: nothing inserted into
  // user_foods, so the compounding moat was inert.
  const source = code(read('services', 'meal-log.ts'))
  assert.match(source, /\.insert\(userFoods\)/, 'commit must upsert the personal food')
  assert.match(source, /onConflictDoUpdate/, 'and must not fail on a repeat log')
})

test('R5 — a correction teaches, not just edits', () => {
  const source = code(read('services', 'corrections.ts'))
  assert.match(source, /\.insert\(userFoods\)/, 'a correction must update the personal food')
  assert.match(source, /\.insert\(knownAttributes\)/, 'and must settle the attribute')
  assert.match(source, /\.update\(meals\)/, 'and must fix the meal totals')
})

test('the correction route exists and is reachable', () => {
  const source = code(read('routes', 'day.ts'))
  assert.match(source, /app\.patch\(\s*'\/meals\/:mealId\/items\/:itemId'/)
  assert.match(source, /correctMealItem\(/)
})

test('repeating a meal advances the streak', () => {
  // The fastest way to log was the only one that silently broke the streak.
  const source = code(read('services', 'usuals.ts'))
  assert.match(source, /recordLoggedDay\(/, 'a repeat is still a logged day')
})

test('streak writes stay outside the meal transaction', () => {
  // A streak-counter failure must never roll back a logged meal.
  for (const file of [
    read('services', 'usuals.ts'),
    read('services', 'meal-log.ts'),
  ]) {
    const stripped = code(file)
    if (!stripped.includes('recordLoggedDay')) continue
    assert.match(
      stripped,
      /try\s*\{[\s\S]{0,400}recordLoggedDay[\s\S]{0,400}\}\s*catch/,
      'recordLoggedDay must be wrapped so its failure cannot lose the meal',
    )
  }
})

test('answers that change what the food IS also change its nutrition', () => {
  // Asking "paneer or tofu?" and then changing nothing is worse than not
  // asking: the user pays the friction and gets none of the accuracy.
  const source = code(read('services', 'meal-log.ts'))
  assert.match(source, /answer\.kind === 'protein_source'/)
  assert.match(source, /answer\.nutrition/)
})

test('meals are always slotted to a meal type', () => {
  const source = code(read('services', 'meal-log.ts'))
  assert.match(
    source,
    /mealType:\s*input\.mealType \?\? inferMealType\(/,
    'a null slot makes "your usual" ignore time of day',
  )
})

test('the snapshot job is actually scheduled', () => {
  // runSnapshot was fully implemented, typed and tested — and never called.
  const server = code(read('server.ts'))
  assert.match(server, /startScheduler\(/, '0G Storage must have something that runs it')
  assert.match(server, /scheduler\.stop\(\)/, 'and must shut down cleanly')

  const scheduler = code(read('jobs', 'scheduler.ts'))
  assert.match(scheduler, /runSnapshot\(/)
})

test('the scheduler cannot run two overlapping passes', () => {
  const source = code(read('jobs', 'scheduler.ts'))
  assert.match(source, /if \(running\) return/, 'concurrent passes would double-write snapshots')
})

test('a snapshot is never attempted without somewhere to address it', () => {
  // This test used to assert the opposite, and was wrong in a way worth
  // recording. It required the query to filter `record_pub_key IS NOT NULL`,
  // treating that as the safety property. The column was never written by
  // anything, so the filter matched no rows for any user — no snapshot was
  // ever built, nothing reached 0G Storage, nothing was ever anchored, and no
  // coach was minted. A total outage that looked exactly like an empty queue,
  // held in place by a passing test.
  //
  // The real property is that ciphertext must have a valid recipient. The way
  // to get one is to create it, not to skip the user.
  const source = code(read('jobs', 'scheduler.ts'))

  assert.doesNotMatch(
    source,
    /record_pub_key IS NOT NULL|recordPubKey} IS NOT NULL/,
    'a missing key must not silently remove somebody from the queue',
  )

  const ensureAt = source.indexOf('ensureRecordKey(')
  const uploadAt = source.indexOf('runSnapshot(')
  assert.ok(ensureAt > -1, 'the key must be obtained before the upload')
  assert.ok(ensureAt < uploadAt, 'and obtained before, not after')
  assert.match(source, /recordPubKey,/, 'and handed to the snapshot as the recipient')
})

test('an unconfigured seed is reported, not silently skipped', () => {
  // The failure mode being prevented: three 0G bindings inert for every user
  // with nothing in the log to say so.
  const source = code(read('jobs', 'scheduler.ts'))
  assert.match(source, /logger\.error\(/, 'a total outage must announce itself')
  assert.match(source, /masterSeed/, 'and name what is missing')
})

test('the coach worker does not filter itself into an empty queue either', () => {
  const source = code(read('jobs', 'coach-brain.ts'))
  assert.doesNotMatch(
    source,
    /record_pub_key IS NOT NULL|recordPubKey} IS NOT NULL/,
    'the same filter emptied this worker too',
  )
  assert.match(source, /ensureRecordKey\(/, 'it creates the key it needs')
})

test('the export promise is checked against the schema, not a list', () => {
  // This used to enumerate eleven table names by hand, which only ever verified
  // what somebody had remembered to add. By the time the export was compared
  // against the schema there were nineteen tables and seven were missing. The
  // real check now lives in export-coverage.test.ts, derived from the schema.
  const source = code(read('routes', 'export.ts'))
  assert.match(source, /inferenceUsage/, 'the attestation receipts belong to the user')
})

test('the export hands over the 0G root hashes', () => {
  // Without them the encrypted copy is unreachable — an export that omitted
  // them would hand someone a copy while quietly keeping the original.
  const source = code(read('routes', 'export.ts'))
  assert.match(source, /rootHashes/)
})

test('every route file that reaches a model also calls the gate', () => {
  const files = ['meals.ts', 'chat.ts', 'coach.ts', 'day.ts', 'users.ts', 'export.ts']
  for (const file of files) {
    const source = code(read('routes', file))
    const touchesModel =
      /\b(complete|readMeal|readMealText|readLabReport|suggestMeal|askOwnData|writeDayLine|writeWeekReview|transcribe)\s*\(/.test(
        source,
      )
    if (!touchesModel) continue
    assert.match(source, /\bguard(Profile)?\s*\(/, `${file} reaches a model without the gate`)
  }
})

test('free-text pantry input is screened before it can reach a suggestion', () => {
  const source = code(read('routes', 'coach.ts'))
  const pantryAt = source.indexOf("'/users/me/pantry'")
  assert.ok(pantryAt > -1)
  const handler = source.slice(pantryAt, pantryAt + 900)
  assert.match(handler, /guard\(/, 'pantry items end up in the suggestion prompt')
})

test('no request handler does a dynamic import', () => {
  for (const file of ['meals.ts', 'chat.ts', 'coach.ts', 'day.ts', 'users.ts', 'export.ts']) {
    const source = code(read('routes', file))
    assert.doesNotMatch(source, /await import\(/, `${file} imports lazily inside a handler`)
  }
})

test('the anchor worker is actually reachable from the server', () => {
  // This is the test that was missing. `findPendingAnchors` and the
  // anchor_tx_hash column existed from the beginning, the contract was written
  // and tested to full coverage, and nothing ever called any of it — so every
  // snapshot's pointer lived only in our database, which is the arrangement the
  // contract exists to replace. A route or a job that nothing invokes is not a
  // feature, and only a wiring test notices.
  const worker = code(read('jobs', 'anchor.ts'))
  assert.match(worker, /findPendingAnchors\s*\(/, 'the worker must read the pending queue')
  assert.match(worker, /\.update\(snapshots\)/, 'and record the result, or it will loop forever')

  const server = code(readFileSync(join(SRC, 'server.ts'), 'utf8'))
  assert.match(server, /startAnchorWorker\s*\(/, 'the server must start the worker')
  assert.match(
    server,
    /anchorWorker\?\.stop\(\)/,
    'and stop it on close, or a timer outlives the process',
  )
})

test('anchoring refuses to run half-configured', () => {
  // An address without a seed cannot sign, and a seed without an address has
  // nowhere to send it. Starting with one and not the other would produce an
  // error per snapshot per pass, forever.
  const server = code(readFileSync(join(SRC, 'server.ts'), 'utf8'))
  assert.match(
    server,
    /OG_ANCHOR_ADDRESS && config\.OG_ANCHOR_MASTER_SEED/,
    'both must be present before the worker starts',
  )
})

test('the snapshot pointer is never anchored twice', () => {
  const worker = code(read('jobs', 'anchor.ts'))
  // The snapshot id is the nonce, so a transaction that succeeded but whose
  // receipt was lost cannot be anchored again — the contract rejects the reuse.
  assert.match(worker, /nonceUsed\s*\(/, 'a retry must check the chain before spending')
})

test('the coach worker is actually reachable from the server', () => {
  // CoachAgent had zero call sites outside its own test file: a contract with
  // full coverage that nothing could reach. Of the four bindings meant to make
  // 0G impossible to remove, ownership was doing no work at all, and "you own
  // your coach" described a row in our database.
  const worker = code(read('jobs', 'coach-brain.ts'))
  assert.match(worker, /client\.mint\(/, 'the worker must actually mint')
  assert.match(worker, /client\.evolve\(/, 'and record what the coach learns')
  assert.match(worker, /\.update\(users\)/, 'and write the token id back, or it mints forever')

  const server = code(readFileSync(join(SRC, 'server.ts'), 'utf8'))
  assert.match(server, /startCoachWorker\(/, 'the server must start it')
  assert.match(server, /coachWorker\?\.stop\(\)/, 'and stop it on close')
})

test('a coach is minted once, not once per pass', () => {
  const worker = code(read('jobs', 'coach-brain.ts'))
  // The nonce is derived from the user id, so a retry after a lost receipt is
  // rejected by the contract rather than producing a second coach.
  assert.match(worker, /nonceUsed\(/, 'a retry must ask the chain first')
  assert.match(worker, /coachTokenId === null/, 'and only mint when there is no coach yet')
})

test('the brain never carries the meal log', () => {
  // The health record is anchored separately and is a different thing. Putting
  // meals in the coach brain would double-store the most sensitive data and
  // blur what the token actually represents.
  const worker = code(read('jobs', 'coach-brain.ts'))
  assert.doesNotMatch(worker, /meals/, 'the brain is what was learned, not what was eaten')
})

test('every route that reaches a model is cost-limited per user', async () => {
  /*
   * A list of route strings can drift from the routes it names, and nothing
   * notices — the control simply stops applying. That is how
   * POST /meals/transcribe ended up calling a speech model, billed per second
   * of audio, with no per-user ceiling at all: only the generic per-IP
   * allowance stood between one account and an unbounded bill.
   *
   * This derives the answer from the handlers instead of trusting the list.
   */
  const { MODEL_ROUTES } = await import('../src/plugins/limits.ts')

  // Built from a list rather than written as one regex: an escape that goes
  // wrong inside a pattern produces something that matches nothing and looks
  // entirely correct. The first version of this test did exactly that — a stray
  // control character meant it detected no routes at all while passing.
  const MODEL_CALLS = [
    'complete',
    'readMeal',
    'readMealText',
    'readLabReport',
    'suggestMeal',
    'askOwnData',
    'writeDayLine',
    'writeWeekReview',
    'transcribe',
  ]
  const callsAModel = (body: string) =>
    MODEL_CALLS.some((name) => body.includes(name + '(') || body.includes(name + ' ('))

  const uncovered: string[] = []

  for (const file of ['meals.ts', 'chat.ts', 'coach.ts', 'day.ts', 'users.ts']) {
    const source = code(read('routes', file))
    const registrations = [
      ...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g),
    ]

    for (const [index, match] of registrations.entries()) {
      const start = match.index ?? 0
      const end = registrations[index + 1]?.index ?? source.length
      const handler = source.slice(start, end)
      if (!callsAModel(handler)) continue

      const route = `${match[1]!.toUpperCase()} ${match[2]}`
      if (!MODEL_ROUTES.includes(route)) uncovered.push(`${route} (${file})`)
    }
  }

  assert.deepEqual(uncovered, [], 'these routes reach a model with no per-user cost limit')
})

test('no cost-limited route names a path that does not exist', async () => {
  // The other direction: a renamed route leaves a dead string behind, and the
  // limit it described silently protects nothing.
  const { MODEL_ROUTES } = await import('../src/plugins/limits.ts')
  const { IDEMPOTENT_ROUTES } = await import('../src/plugins/idempotency.ts')

  let declared = ''
  for (const file of ['meals.ts', 'chat.ts', 'coach.ts', 'day.ts', 'users.ts', 'auth.ts']) {
    declared += code(read('routes', file))
  }

  for (const route of [...MODEL_ROUTES, ...IDEMPOTENT_ROUTES]) {
    const path = route.slice(route.indexOf(' ') + 1)
    assert.ok(
      declared.includes(`'${path}'`),
      `${route} is declared but no route registers that path`,
    )
  }
})
