import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basalMetabolicRate, bmi, computeTargets, type UserProfile } from '../src/targets.ts'

const base: UserProfile = {
  sex: 'male',
  ageYears: 26,
  heightCm: 175,
  weightKg: 78,
  activity: 'moderate',
  goal: 'lose',
}

test('Mifflin-St Jeor matches the published formula', () => {
  // 10*78 + 6.25*175 - 5*26 + 5 = 780 + 1093.75 - 130 + 5 = 1748.75
  assert.equal(Math.round(basalMetabolicRate(base)), 1749)
  // female variant is -161 instead of +5
  assert.equal(Math.round(basalMetabolicRate({ ...base, sex: 'female' })), 1583)
})

test('bmi is computed correctly', () => {
  assert.equal(Math.round(bmi(78, 175) * 10) / 10, 25.5)
})

test('a cut lands below maintenance but above the floor', () => {
  const t = computeTargets(base)
  assert.ok(t.calories < t.tdee, 'cut should be below TDEE')
  assert.ok(t.calories >= 1500, 'male floor is 1500 kcal')
})

test('an unsafe requested pace is clamped and disclosed', () => {
  const t = computeTargets({ ...base, paceKgPerWeek: 3 })
  assert.ok(t.safetyNotes.some((n) => /Pace limited/.test(n)))
  // The cap is applied to unrounded values, so allow 1 kcal of rounding drift.
  assert.ok(t.calories >= t.tdee * 0.75 - 1, 'deficit must not exceed 25% of TDEE')
})

test('a small light-framed woman is never planned below 1200 kcal', () => {
  const t = computeTargets({
    sex: 'female',
    ageYears: 24,
    heightCm: 150,
    weightKg: 45,
    activity: 'sedentary',
    goal: 'lose',
    paceKgPerWeek: 1,
  })
  assert.ok(t.calories >= 1200, `got ${t.calories}`)
  assert.ok(t.safetyNotes.length > 0, 'clamping must be disclosed')
})

test('protein is higher in a deficit than at maintenance', () => {
  const cut = computeTargets(base)
  const maintain = computeTargets({ ...base, goal: 'maintain' })
  assert.ok(cut.proteinG > maintain.proteinG)
  assert.equal(cut.proteinG, Math.round(2.0 * 78))
})

test('macros never go negative and always reconcile to calories', () => {
  for (const weightKg of [42, 55, 60, 78, 95, 110, 130]) {
    for (const goal of ['lose', 'gain', 'maintain', 'recomp'] as const) {
      for (const sex of ['male', 'female'] as const) {
        const t = computeTargets({ ...base, weightKg, goal, sex })
        assert.ok(t.carbG >= 0, `negative carbs at ${weightKg}kg/${goal}/${sex}`)
        assert.ok(t.fatG > 0 && t.proteinG > 0)
        const fromMacros = t.proteinG * 4 + t.carbG * 4 + t.fatG * 9
        assert.ok(
          Math.abs(fromMacros - t.calories) <= 12,
          `macros ${fromMacros} drift from calories ${t.calories} at ${weightKg}kg/${goal}/${sex}`,
        )
      }
    }
  }
})

test('a bulk sits above maintenance but is capped at 20%', () => {
  const t = computeTargets({ ...base, goal: 'gain', paceKgPerWeek: 2 })
  assert.ok(t.calories > t.tdee)
  assert.ok(t.calories <= t.tdee * 1.2 + 1)
})

test('maintain returns TDEE with no adjustment note', () => {
  const t = computeTargets({ ...base, goal: 'maintain' })
  assert.equal(t.calories, t.tdee)
  assert.deepEqual(t.safetyNotes, [])
})

test('activity level monotonically raises TDEE', () => {
  const levels = ['sedentary', 'light', 'moderate', 'active', 'very_active'] as const
  let previous = 0
  for (const activity of levels) {
    const t = computeTargets({ ...base, activity })
    assert.ok(t.tdee > previous, `${activity} did not increase TDEE`)
    previous = t.tdee
  }
})

test('targets are deterministic — same input, same output', () => {
  const a = computeTargets(base)
  const b = computeTargets(base)
  assert.deepEqual(a, b)
})
