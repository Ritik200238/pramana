import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LABEL, classify, rollUp } from '../src/confidence.ts'

test('a barcode is exact regardless of anything else', () => {
  assert.equal(
    classify({ fromBarcode: true, allSignificantAnswered: false, userSettledAnAmount: false, minItemConfidence: 0.1 }),
    'exact',
  )
})

test('answered questions plus decent model confidence is confirmed', () => {
  assert.equal(
    classify({ fromBarcode: false, allSignificantAnswered: true, userSettledAnAmount: true, minItemConfidence: 0.8 }),
    'confirmed',
  )
})

test('an unanswered significant unknown forces rough', () => {
  assert.equal(
    classify({ fromBarcode: false, allSignificantAnswered: false, userSettledAnAmount: false, minItemConfidence: 0.95 }),
    'rough',
  )
})

test('low model confidence forces rough even when everything was answered', () => {
  assert.equal(
    classify({ fromBarcode: false, allSignificantAnswered: true, userSettledAnAmount: true, minItemConfidence: 0.4 }),
    'rough',
  )
})

test('a day is only as good as its weakest entry', () => {
  assert.equal(rollUp(['exact', 'confirmed', 'rough']), 'rough')
  assert.equal(rollUp(['exact', 'confirmed']), 'confirmed')
  assert.equal(rollUp(['exact', 'exact']), 'exact')
})

test('an empty day is rough, not exact', () => {
  assert.equal(rollUp([]), 'rough')
})

test('every level has a badge and a plain-language explanation', () => {
  for (const level of ['exact', 'confirmed', 'rough'] as const) {
    assert.ok(LABEL[level].badge.length > 0)
    assert.ok(LABEL[level].short.length > 0)
    assert.ok(LABEL[level].explain.length > 0)
  }
})

test('nothing asked and nothing told is rough, however sure the model sounds', () => {
  /*
   * The vacuous case, and the one that reached production semantics: a model
   * that raises no unknowns leaves "every significant unknown was answered"
   * trivially true, because there were none. Measured on the live 0G Compute
   * provider, that is what it does — committed amounts at a flat 0.9, no
   * unknowns — so this is the normal path and not a corner.
   *
   * `confirmed` reads "You told us the amounts that mattered". Nobody told us
   * anything here.
   */
  assert.equal(
    classify({
      fromBarcode: false,
      allSignificantAnswered: true,
      userSettledAnAmount: false,
      minItemConfidence: 0.95,
    }),
    'rough',
  )
})

test('an amount they settled earlier still counts as theirs', () => {
  // R4 skips a question this person already answered once. Skipped is not the
  // same as never asked, and treating them alike would punish the returning
  // user the product is built for.
  assert.equal(
    classify({
      fromBarcode: false,
      allSignificantAnswered: true,
      userSettledAnAmount: true,
      minItemConfidence: 0.8,
    }),
    'confirmed',
  )
})
