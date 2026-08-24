import { test } from 'node:test'
import assert from 'node:assert/strict'
import { knownKey } from '@ogt/core'
import {
  applyAnswers,
  buildDraft,
  classifyMeal,
  cookingFatKcal,
  normalise,
  totalsOf,
  type AnswerInput,
  type DraftItem,
} from '../src/services/meal-log.ts'
import type { VisionResult } from '../src/pipeline/meal-vision.ts'

/** A realistic Indian dinner: dal, roti, sabzi. */
function thali(): VisionResult {
  return {
    notFood: false,
    items: [
      {
        id: 'dal',
        name: 'Arhar dal',
        unit: 'katori',
        unitsLow: 1,
        unitsHigh: 2,
        gramsPerUnit: 150,
        kcalPer100g: 116,
        proteinPer100g: 7.6,
        carbPer100g: 18,
        fatPer100g: 1.4,
        confidence: 0.72,
      },
      {
        id: 'roti',
        name: 'Roti',
        unit: 'roti',
        unitsLow: 2,
        unitsHigh: 3,
        gramsPerUnit: 35,
        kcalPer100g: 297,
        proteinPer100g: 11,
        carbPer100g: 58,
        fatPer100g: 3.7,
        confidence: 0.88,
      },
      {
        id: 'sabzi',
        name: 'Bhindi sabzi',
        unit: 'katori',
        unitsLow: 1,
        unitsHigh: 1,
        gramsPerUnit: 120,
        kcalPer100g: 95,
        proteinPer100g: 2,
        carbPer100g: 8,
        fatPer100g: 6,
        confidence: 0.65,
      },
    ],
    unknowns: [
      {
        itemId: 'dal',
        kind: 'portion',
        options: ['1 katori', '2 katori'],
        kcalSwing: 174,
        proteinSwingG: 11.4,
        confidence: 0.4,
      },
      {
        itemId: 'roti',
        kind: 'cooking_fat',
        options: ['plain', 'with ghee'],
        kcalSwing: 120,
        proteinSwingG: 0,
        confidence: 0.3,
      },
      {
        itemId: 'sabzi',
        kind: 'cooking_fat',
        options: ['light oil', 'generous oil'],
        kcalSwing: 90,
        proteinSwingG: 0,
        confidence: 0.35,
      },
      {
        itemId: 'sabzi',
        kind: 'preparation',
        options: ['dry', 'gravy'],
        kcalSwing: 8,
        proteinSwingG: 0.2,
        confidence: 0.5,
      },
    ],
  }
}

const NONE: ReadonlySet<string> = new Set()

test('R2 — a fresh user is asked at most two questions', () => {
  const draft = buildDraft(thali(), NONE)
  assert.equal(draft.plan.ask.length, 2)
})

test('the two questions chosen are the highest-impact ones', () => {
  const draft = buildDraft(thali(), NONE)
  const asked = draft.plan.ask.map((q) => `${q.unknown.itemId}:${q.unknown.kind}`)
  assert.ok(asked.includes('dal:portion'), 'the biggest swing must be asked')
  assert.ok(!asked.includes('sabzi:preparation'), 'an 8 kcal swing must never be asked')
})

test('a trivial unknown is silently ignored, not deferred', () => {
  const draft = buildDraft(thali(), NONE)
  const ignoredKinds = draft.plan.ignored.map((u) => `${u.itemId}:${u.kind}`)
  assert.ok(ignoredKinds.includes('sabzi:preparation'))
})

test('R4 — the thesis metric: questions decay to zero as answers accumulate', () => {
  // Week 1: nothing settled.
  const week1 = buildDraft(thali(), NONE)
  assert.equal(week1.plan.ask.length, 2)

  // Week 2: the dal portion is settled.
  //
  // The visible ask count is still 2 here, and that is correct — there were
  // three significant unknowns against a cap of two, so settling one promotes
  // the previously deferred third. The decay shows up in total burden before it
  // shows up in the number of questions on screen.
  const partial = new Set([knownKey('Arhar dal', 'portion')])
  const week2 = buildDraft(thali(), partial)
  const burden1 = week1.plan.ask.length + week1.plan.unresolved.length
  const burden2 = week2.plan.ask.length + week2.plan.unresolved.length
  assert.ok(burden2 < burden1, 'settling an answer must reduce the total outstanding questions')
  assert.equal(week2.skippedKnown, 1)

  // Week 4: everything significant is settled. This is the number that decides
  // whether the product has a reason to exist — see PRD 6.2.
  const settled = new Set([
    knownKey('Arhar dal', 'portion'),
    knownKey('Roti', 'cooking_fat'),
    knownKey('Bhindi sabzi', 'cooking_fat'),
  ])
  const week4 = buildDraft(thali(), settled)
  assert.equal(week4.plan.ask.length, 0, 'a settled user must be asked nothing')
  assert.equal(week4.plan.unresolved.length, 0, 'and nothing may be left unresolved either')
  assert.equal(week4.skippedKnown, 3)
})

test('answering a portion changes the total', () => {
  const draft = buildDraft(thali(), NONE)
  const before = draft.totals.kcal

  const answered = applyAnswers(draft, [
    { itemId: 'dal', kind: 'portion', answer: '2 katori', units: 2 },
  ])

  assert.ok(answered.totals.kcal > before, 'a larger portion must raise the total')
})

test('ghee is worth a meaningful number of calories', () => {
  const draft = buildDraft(thali(), NONE)
  const plain = draft.totals.kcal

  const withGhee = applyAnswers(draft, [
    {
      itemId: 'roti',
      kind: 'cooking_fat',
      answer: 'with ghee',
      cookingFat: 'ghee',
      cookingFatTsp: 2,
    },
  ])

  const difference = withGhee.totals.kcal - plain
  assert.ok(difference >= 70, `ghee must move the number materially, got ${difference}`)
})

test('cooking fat contributes to fat grams as well as calories', () => {
  const item: DraftItem = {
    id: 'x',
    name: 'Roti',
    unit: 'roti',
    units: 2,
    gramsPerUnit: 35,
    kcalPer100g: 297,
    proteinPer100g: 11,
    carbPer100g: 58,
    fatPer100g: 3.7,
    modelConfidence: 0.9,
    cookingFat: 'ghee',
    cookingFatTsp: 1,
  }
  const totals = totalsOf([item])
  const plain = totalsOf([{ ...item, cookingFat: 'none' }])
  assert.ok(totals.fatG > plain.fatG, 'added fat must appear in the fat macro, not only calories')
})

test('no cooking fat means no added calories', () => {
  const item: DraftItem = {
    id: 'x',
    name: 'Dal',
    unit: 'katori',
    units: 1,
    gramsPerUnit: 150,
    kcalPer100g: 116,
    proteinPer100g: 7.6,
    carbPer100g: 18,
    fatPer100g: 1.4,
    modelConfidence: 0.8,
  }
  assert.equal(cookingFatKcal(item), 0)
})

test('R3 — an unanswered significant unknown forces rough', () => {
  const draft = buildDraft(thali(), NONE)
  // Two questions asked, one answered: the meal cannot be "confirmed".
  const answers: AnswerInput[] = [
    { itemId: 'dal', kind: 'portion', answer: '1 katori', units: 1 },
  ]
  const { mealConfidence } = classifyMeal(draft, answers)
  assert.equal(mealConfidence, 'rough')
})

test('R3 — answering everything asked, with no leftovers, gives confirmed', () => {
  // Settle the third unknown up front so nothing lands in `unresolved`.
  const known = new Set([knownKey('Bhindi sabzi', 'cooking_fat')])
  const draft = buildDraft(thali(), known)

  const answers: AnswerInput[] = draft.plan.ask.map((question) => ({
    itemId: question.unknown.itemId,
    kind: question.unknown.kind,
    answer: question.unknown.options[0] ?? 'yes',
    ...(question.unknown.kind === 'portion' ? { units: 1 } : {}),
  }))

  const { mealConfidence } = classifyMeal(draft, answers)
  assert.equal(mealConfidence, 'confirmed')
})

test('R3 — low model confidence keeps an item rough even when answered', () => {
  const vision = thali()
  // Force every item well below the ceiling.
  vision.items = vision.items.map((item) => ({ ...item, confidence: 0.3 }))
  const known = new Set([knownKey('Bhindi sabzi', 'cooking_fat')])
  const draft = buildDraft(vision, known)

  const answers: AnswerInput[] = draft.plan.ask.map((question) => ({
    itemId: question.unknown.itemId,
    kind: question.unknown.kind,
    answer: question.unknown.options[0] ?? 'yes',
    units: 1,
  }))

  const { mealConfidence } = classifyMeal(draft, answers)
  assert.equal(mealConfidence, 'rough')
})

test('an unknown pointing at a missing item is dropped, not crashed on', () => {
  const vision = thali()
  vision.unknowns.push({
    itemId: 'ghost',
    kind: 'portion',
    options: ['1', '2'],
    kcalSwing: 999,
    proteinSwingG: 99,
    confidence: 0.1,
  })

  const draft = buildDraft(vision, NONE)
  const asked = draft.plan.ask.map((q) => q.unknown.itemId)
  assert.ok(!asked.includes('ghost'), 'cannot ask about a dish that is not on the plate')
})

test('an empty plate produces no questions and zero totals', () => {
  const draft = buildDraft({ items: [], unknowns: [], notFood: true }, NONE)
  assert.equal(draft.plan.ask.length, 0)
  assert.equal(draft.totals.kcal, 0)
})

test('normalise makes food names match regardless of case and spacing', () => {
  assert.equal(normalise('  Dal   Tadka '), 'dal tadka')
  assert.equal(normalise('DAL TADKA'), normalise('dal tadka'))
})

test('drafting is deterministic', () => {
  const a = buildDraft(thali(), NONE)
  const b = buildDraft(thali(), NONE)
  assert.deepEqual(a.plan.ask.map((q) => q.text), b.plan.ask.map((q) => q.text))
  assert.deepEqual(a.totals, b.totals)
})
