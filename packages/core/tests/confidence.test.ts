import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LABEL, classify, rollUp } from '../src/confidence.ts'

test('a barcode is exact regardless of anything else', () => {
  assert.equal(
    classify({ fromBarcode: true, allSignificantAnswered: false, minItemConfidence: 0.1 }),
    'exact',
  )
})

test('answered questions plus decent model confidence is confirmed', () => {
  assert.equal(
    classify({ fromBarcode: false, allSignificantAnswered: true, minItemConfidence: 0.8 }),
    'confirmed',
  )
})

test('an unanswered significant unknown forces rough', () => {
  assert.equal(
    classify({ fromBarcode: false, allSignificantAnswered: false, minItemConfidence: 0.95 }),
    'rough',
  )
})

test('low model confidence forces rough even when everything was answered', () => {
  assert.equal(
    classify({ fromBarcode: false, allSignificantAnswered: true, minItemConfidence: 0.4 }),
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
