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
  const source = code(read('jobs', 'scheduler.ts'))
  assert.match(
    source,
    /recordPubKey.*IS NOT NULL|IS NOT NULL/,
    'no record key means no safe ciphertext recipient',
  )
})

test('export includes every table the product writes', () => {
  // "Export everything, free, forever" becomes false the moment a new table is
  // added and not listed here.
  const source = code(read('routes', 'export.ts'))
  for (const table of [
    'meals',
    'mealItems',
    'weightLogs',
    'lifeFacts',
    'chatMessages',
    'userFoods',
    'knownAttributes',
    'snapshots',
    'healthMarkers',
    'labReports',
    'streaks',
  ]) {
    assert.match(source, new RegExp(`\\b${table}\\b`), `export omits ${table}`)
  }
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
