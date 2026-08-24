/**
 * The lab report boundary.
 *
 * This feature has one line it must not cross: it explains what a marker
 * measures, and never what it means for the person. Crossing that line makes
 * this a medical device and makes us liable — the Whoop precedent is explicit
 * that measuring a diagnosable parameter is what counts, regardless of how the
 * product is framed.
 *
 * The prompt forbids it, but a prompt is a request. These tests cover the
 * deterministic guard behind it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SAFE_FALLBACK_SUMMARY,
  deriveFlag,
  sanitiseSummary,
  type ExtractedMarker,
} from '../src/pipeline/lab-report.ts'

function marker(over: Partial<ExtractedMarker> = {}): ExtractedMarker {
  return {
    code: 'hba1c',
    name: 'HbA1c',
    value: 5.4,
    unit: '%',
    refLow: 4.0,
    refHigh: 5.6,
    flag: 'normal',
    ...over,
  }
}

// ----------------------------------------------------------- the guard rail

test('a summary naming a condition is replaced, not shown', () => {
  const named = 'Your HbA1c of 6.4 suggests you are pre-diabetic and should start medication.'
  assert.equal(sanitiseSummary(named), SAFE_FALLBACK_SUMMARY)
})

test('every diagnostic phrasing we could think of is caught', () => {
  const unsafe = [
    'This indicates diabetes.',
    'You have anaemia.',
    'These results are consistent with hypothyroidism.',
    'This suggests that you may have a vitamin deficiency.',
    'You are likely have an infection.',
    'This is a sign of kidney disease.',
    'Your results indicate that you should be concerned about thyroid.',
  ]
  for (const text of unsafe) {
    assert.equal(sanitiseSummary(text), SAFE_FALLBACK_SUMMARY, `not caught: "${text}"`)
  }
})

test('the fallback still routes them to a doctor', () => {
  assert.match(SAFE_FALLBACK_SUMMARY, /doctor/i)
})

test('an educational summary passes through untouched', () => {
  const safe =
    'HbA1c measures your average blood sugar over about three months. ' +
    'LDL is one of the cholesterol fractions carried in your blood.'
  assert.equal(sanitiseSummary(safe), safe)
})

test('explaining what a marker measures is not diagnosis', () => {
  const safe = 'Haemoglobin is the protein in red blood cells that carries oxygen.'
  assert.equal(sanitiseSummary(safe), safe)
})

test('the summary is trimmed', () => {
  assert.equal(sanitiseSummary('  Vitamin D measures a hormone precursor.  '), 'Vitamin D measures a hormone precursor.')
})

// -------------------------------------------------------------- flag maths

test('a value inside the printed range is normal', () => {
  assert.equal(deriveFlag(marker({ value: 5.0 })), 'normal')
})

test('a value above the printed range is high', () => {
  assert.equal(deriveFlag(marker({ value: 6.4 })), 'high')
})

test('a value below the printed range is low', () => {
  assert.equal(deriveFlag(marker({ value: 3.2 })), 'low')
})

test('boundaries are inclusive — exactly at the limit is normal', () => {
  assert.equal(deriveFlag(marker({ value: 5.6 })), 'normal')
  assert.equal(deriveFlag(marker({ value: 4.0 })), 'normal')
})

test('a one-sided range still classifies', () => {
  assert.equal(deriveFlag(marker({ refLow: null, value: 9 })), 'high')
  assert.equal(deriveFlag(marker({ refHigh: null, value: 1 })), 'low')
  assert.equal(deriveFlag(marker({ refHigh: null, value: 9 })), 'normal')
})

test('no printed range means unknown, never a guess', () => {
  // Reference ranges differ between labs. Substituting a remembered one is how
  // you tell somebody their normal result is abnormal.
  assert.equal(deriveFlag(marker({ refLow: null, refHigh: null })), 'unknown')
})

test('our arithmetic overrides the model when they disagree', () => {
  // The model claimed normal; the printed range says otherwise.
  const disagreeing = marker({ value: 7.9, flag: 'normal' })
  assert.equal(deriveFlag(disagreeing), 'high')
})

test('the extraction prompt forbids interpretation', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'pipeline', 'lab-report.ts'),
    'utf8',
  )

  assert.match(source, /name a condition or disease/i)
  assert.match(source, /suggest treatment/i)
  assert.match(source, /never substitute a range you remember/i)
})
