import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FREEZE_GRANT_PER_WEEK,
  MAX_FREEZES,
  advanceStreak,
  daysBetween,
  isoWeek,
  localDate,
} from '../src/services/streaks.ts'

const IST = 330

function base(over: Partial<Parameters<typeof advanceStreak>[0]['previous']> = {}) {
  return {
    currentDays: 0,
    longestDays: 0,
    lastLoggedDate: null as string | null,
    freezesAvailable: 1,
    freezeRefreshedOn: null as string | null,
    ...over,
  }
}

test('the first logged day starts a streak of one', () => {
  const result = advanceStreak({ previous: base(), today: '2026-08-24' })
  assert.equal(result.currentDays, 1)
  assert.equal(result.longestDays, 1)
})

test('consecutive days extend the streak', () => {
  const result = advanceStreak({
    previous: base({ currentDays: 4, longestDays: 9, lastLoggedDate: '2026-08-23' }),
    today: '2026-08-24',
  })
  assert.equal(result.currentDays, 5)
  assert.equal(result.longestDays, 9, 'the record stands until beaten')
  assert.equal(result.freezeSpent, false)
})

test('logging twice in a day does not extend the streak', () => {
  const result = advanceStreak({
    previous: base({ currentDays: 3, longestDays: 3, lastLoggedDate: '2026-08-24' }),
    today: '2026-08-24',
  })
  assert.equal(result.currentDays, 3)
})

test('a single missed day is covered by a freeze, silently', () => {
  const result = advanceStreak({
    previous: base({
      currentDays: 6,
      longestDays: 6,
      lastLoggedDate: '2026-08-22',
      freezesAvailable: 1,
      freezeRefreshedOn: isoWeek('2026-08-24'),
    }),
    today: '2026-08-24',
  })
  assert.equal(result.currentDays, 7, 'guilt loses users; forgiveness keeps them')
  assert.equal(result.freezesAvailable, 0)
  assert.equal(result.freezeSpent, true)
})

test('a gap longer than the freezes available resets the streak', () => {
  const result = advanceStreak({
    previous: base({
      currentDays: 12,
      longestDays: 12,
      lastLoggedDate: '2026-08-18',
      freezesAvailable: 1,
      freezeRefreshedOn: isoWeek('2026-08-24'),
    }),
    today: '2026-08-24',
  })
  assert.equal(result.currentDays, 1)
  assert.equal(result.longestDays, 12, 'the record survives a reset')
  assert.equal(result.freezesAvailable, 1, 'an unaffordable gap must not consume freezes')
})

test('a new week grants a freeze, capped', () => {
  const result = advanceStreak({
    previous: base({
      currentDays: 3,
      longestDays: 3,
      lastLoggedDate: '2026-08-23',
      freezesAvailable: MAX_FREEZES,
      freezeRefreshedOn: '2026-W01',
    }),
    today: '2026-08-24',
  })
  assert.equal(result.freezesAvailable, MAX_FREEZES, 'the cap must hold')
})

test('freezes do not accumulate within the same week', () => {
  const week = isoWeek('2026-08-24')
  const first = advanceStreak({
    previous: base({ currentDays: 1, lastLoggedDate: '2026-08-23', freezesAvailable: 0, freezeRefreshedOn: week }),
    today: '2026-08-24',
  })
  assert.equal(first.freezesAvailable, 0, 'already refreshed this week')
})

test('two missed days need two freezes', () => {
  const withOne = advanceStreak({
    previous: base({
      currentDays: 5,
      lastLoggedDate: '2026-08-21',
      freezesAvailable: 1,
      freezeRefreshedOn: isoWeek('2026-08-24'),
    }),
    today: '2026-08-24',
  })
  assert.equal(withOne.currentDays, 1, 'one freeze cannot bridge two missed days')

  const withTwo = advanceStreak({
    previous: base({
      currentDays: 5,
      lastLoggedDate: '2026-08-21',
      freezesAvailable: 2,
      freezeRefreshedOn: isoWeek('2026-08-24'),
    }),
    today: '2026-08-24',
  })
  assert.equal(withTwo.currentDays, 6)
  assert.equal(withTwo.freezesAvailable, 0)
})

test('the streak record is never lost, only the current run', () => {
  const result = advanceStreak({
    previous: base({ currentDays: 30, longestDays: 30, lastLoggedDate: '2026-07-01' }),
    today: '2026-08-24',
  })
  assert.equal(result.currentDays, 1)
  assert.equal(result.longestDays, 30)
})

test('local dates respect the offset', () => {
  // 18:30Z is 00:00 IST the next day.
  assert.equal(localDate(new Date('2026-08-24T18:30:00Z'), IST), '2026-08-25')
  assert.equal(localDate(new Date('2026-08-24T18:29:00Z'), IST), '2026-08-24')
})

test('daysBetween counts calendar days', () => {
  assert.equal(daysBetween('2026-08-23', '2026-08-24'), 1)
  assert.equal(daysBetween('2026-08-24', '2026-08-24'), 0)
  assert.equal(daysBetween('2026-08-01', '2026-09-01'), 31)
})

test('isoWeek groups a week together and separates the next', () => {
  assert.equal(isoWeek('2026-08-24'), isoWeek('2026-08-26'))
  assert.notEqual(isoWeek('2026-08-24'), isoWeek('2026-09-02'))
})

test('the weekly grant is one', () => {
  assert.equal(FREEZE_GRANT_PER_WEEK, 1)
})
