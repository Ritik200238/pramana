/**
 * The proactive engine's limits.
 *
 * These are the tests that keep feature 03 from becoming the thing users hate.
 * Every limit is asserted here because a limit that lives only in a prompt is
 * not a limit.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MIN_HOURS_BETWEEN,
  QUIET_END_HOUR,
  QUIET_START_HOUR,
  isQuietHours,
} from '../src/services/proactive.ts'
import { labelOf, signatureOf } from '../src/services/usuals.ts'

const IST = 330

function istTime(hour: number): Date {
  // Build a UTC instant that lands on `hour` in IST.
  const utcMinutes = hour * 60 - IST
  const date = new Date('2026-08-24T00:00:00Z')
  date.setUTCMinutes(date.getUTCMinutes() + utcMinutes)
  return date
}

test('quiet hours cover night, and daytime is open', () => {
  assert.equal(isQuietHours(istTime(23), IST), true, '11pm must be quiet')
  assert.equal(isQuietHours(istTime(3), IST), true, '3am must be quiet')
  assert.equal(isQuietHours(istTime(6), IST), true, '6am must be quiet')
  assert.equal(isQuietHours(istTime(9), IST), false)
  assert.equal(isQuietHours(istTime(20), IST), false)
})

test('the quiet window boundaries are exactly as documented', () => {
  assert.equal(isQuietHours(istTime(QUIET_START_HOUR), IST), true, 'quiet starts at 22:00')
  assert.equal(isQuietHours(istTime(QUIET_START_HOUR - 1), IST), false, '21:00 is still fine')
  assert.equal(isQuietHours(istTime(QUIET_END_HOUR), IST), false, 'quiet ends at 07:00')
  assert.equal(isQuietHours(istTime(QUIET_END_HOUR - 1), IST), true, '06:00 is still quiet')
})

test('the rate limit is one message per day, not per hour', () => {
  assert.equal(MIN_HOURS_BETWEEN, 24)
})

test('opt-out is checked before anything else can fire', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'proactive.ts'),
    'utf8',
  )
  const optOutAt = source.indexOf('user.proactiveOptOut')
  const quietAt = source.indexOf('isQuietHours(now')
  const triggerAt = source.indexOf('followUpOnOpenSymptom(')

  assert.ok(optOutAt > -1, 'opt-out must be honoured')
  assert.ok(optOutAt < quietAt, 'opt-out is checked before quiet hours')
  assert.ok(optOutAt < triggerAt, 'opt-out is checked before any trigger runs')
})

test('there is no path that re-prompts an opted-out user', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'proactive.ts'),
    'utf8',
  )
  // The only write to proactiveOptOut lives in the users route, setting it true.
  assert.doesNotMatch(source, /proactiveOptOut:\s*false/, 'nothing may silently re-enable this')
})

test('only unresolved facts can trigger a message', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'proactive.ts'),
    'utf8',
  )
  const isNullCount = (source.match(/isNull\(lifeFacts\.resolvedAt\)/g) ?? []).length
  assert.ok(
    isNullCount >= 2,
    'every fact-based trigger must exclude resolved topics — this is the gaslighting fix',
  )
})

test('a follow-up quotes the user verbatim rather than paraphrasing', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'proactive.ts'),
    'utf8',
  )
  assert.match(source, /fact\.verbatim/, 'their words, not our summary of their words')
})

test('generic nudges are absent from the messages we actually send', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'proactive.ts'),
    'utf8',
  )
  // Strip comments first: the file names these phrases in order to forbid them,
  // and a naive scan would flag its own documentation.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  assert.doesNotMatch(code, /Don'?t forget to log/i)
  assert.doesNotMatch(code, /Time to log/i)
  assert.doesNotMatch(code, /Keep up the/i, 'no cheerleading either')
})

test('recording a message updates the timestamp that enforces the limit', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'proactive.ts'),
    'utf8',
  )
  assert.match(source, /lastProactiveAt:\s*new Date\(\)/, 'the limit must be enforced by state')
})

// ------------------------------------------------------------------ usuals

test('a meal signature ignores order', () => {
  assert.equal(signatureOf(['Dal', 'Roti', 'Bhindi']), signatureOf(['bhindi', 'dal', 'ROTI']))
})

test('different meals get different signatures', () => {
  assert.notEqual(signatureOf(['Dal', 'Roti']), signatureOf(['Dal', 'Rice']))
})

test('a usual reads like something a person would say', () => {
  assert.equal(
    labelOf([
      { name: 'Dal', portion: '1 katori' },
      { name: 'Roti', portion: '2 roti' },
    ]),
    'Dal and Roti',
  )
  assert.equal(labelOf([{ name: 'Poha', portion: '1 plate' }]), 'Poha')
})

test('a long meal is summarised rather than listed', () => {
  const label = labelOf([
    { name: 'Dal', portion: '1' },
    { name: 'Roti', portion: '2' },
    { name: 'Bhindi', portion: '1' },
    { name: 'Curd', portion: '1' },
    { name: 'Salad', portion: '1' },
  ])
  assert.match(label, /\+2$/, 'extra dishes are counted, not enumerated')
})

test('an empty meal still has a label', () => {
  assert.equal(labelOf([]), 'Meal')
})
