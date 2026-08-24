import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayBounds, inferMealType } from '../src/services/day.ts'

const IST = 330

test('a day runs from local midnight to local midnight', () => {
  // 2026-08-24T18:30:00Z is 2026-08-25T00:00 IST — the first instant of the 25th.
  const { from, to } = dayBounds(new Date('2026-08-24T18:30:00Z'), IST)
  assert.equal(from.toISOString(), '2026-08-24T18:30:00.000Z')
  assert.equal(to.toISOString(), '2026-08-25T18:30:00.000Z')
})

test('late-evening IST still belongs to the same local day', () => {
  // 22:00 IST on the 24th is 16:30Z — the day must start that morning IST,
  // not roll over because UTC has not.
  const { from } = dayBounds(new Date('2026-08-24T16:30:00Z'), IST)
  assert.equal(from.toISOString(), '2026-08-23T18:30:00.000Z')
})

test('a dinner logged just before local midnight counts as that day', () => {
  const at = new Date('2026-08-24T18:25:00Z') // 23:55 IST on the 24th
  const { from, to } = dayBounds(at, IST)
  assert.ok(at >= from && at < to, 'the meal must fall inside its own local day')
})

test('a day is exactly 24 hours', () => {
  const { from, to } = dayBounds(new Date('2026-08-24T09:00:00Z'), IST)
  assert.equal(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000)
})

test('day bounds work for other offsets too', () => {
  const { from, to } = dayBounds(new Date('2026-08-24T09:00:00Z'), 0)
  assert.equal(from.toISOString(), '2026-08-24T00:00:00.000Z')
  assert.equal(to.toISOString(), '2026-08-25T00:00:00.000Z')
})

test('meal slots follow Indian eating times', () => {
  const at = (istHour: number) => {
    const utcHour = istHour - 5.5
    const date = new Date('2026-08-24T00:00:00Z')
    date.setUTCMinutes(date.getUTCMinutes() + utcHour * 60)
    return date
  }

  assert.equal(inferMealType(at(8), IST), 'breakfast')
  assert.equal(inferMealType(at(13), IST), 'lunch')
  assert.equal(inferMealType(at(21), IST), 'dinner')
  assert.equal(inferMealType(at(17), IST), 'snack', 'late-afternoon chai is a snack, not a meal')
  assert.equal(inferMealType(at(2), IST), 'snack')
})
