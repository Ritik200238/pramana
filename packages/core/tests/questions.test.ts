import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPACT_THRESHOLD,
  MAX_QUESTIONS,
  impactOf,
  knownKey,
  planQuestions,
  type Unknown,
} from '../src/questions.ts'

function unknown(over: Partial<Unknown> = {}): Unknown {
  return {
    kind: 'portion',
    itemId: 'i1',
    itemName: 'dal',
    kcalSwing: 150,
    proteinSwingG: 6,
    confidence: 0.5,
    options: ['1 katori', '2 katori'],
    ...over,
  }
}

const EMPTY: ReadonlySet<string> = new Set()

test('a high-impact unknown is asked', () => {
  const plan = planQuestions({
    unknowns: [unknown()],
    mealKcal: 600,
    mealProteinG: 25,
    known: EMPTY,
  })
  assert.equal(plan.ask.length, 1)
  assert.equal(plan.ignored.length, 0)
})

test('a low-impact unknown is silently ignored, never asked', () => {
  // 15 kcal on a 600 kcal meal = 2.5%, well under threshold.
  const garnish = unknown({ itemName: 'onion', kcalSwing: 15, proteinSwingG: 0.2 })
  const plan = planQuestions({
    unknowns: [garnish],
    mealKcal: 600,
    mealProteinG: 25,
    known: EMPTY,
  })
  assert.equal(plan.ask.length, 0)
  assert.equal(plan.ignored.length, 1)
})

test('R2 — never more than two questions, however many unknowns exist', () => {
  const many = [
    unknown({ itemId: 'a', itemName: 'dal', kcalSwing: 200 }),
    unknown({ itemId: 'b', itemName: 'roti', kcalSwing: 180, kind: 'cooking_fat' }),
    unknown({ itemId: 'c', itemName: 'sabzi', kcalSwing: 160, kind: 'cooking_fat' }),
    unknown({ itemId: 'd', itemName: 'curd', kcalSwing: 140 }),
  ]
  const plan = planQuestions({ unknowns: many, mealKcal: 700, mealProteinG: 30, known: EMPTY })
  assert.equal(plan.ask.length, MAX_QUESTIONS)
  assert.equal(plan.unresolved.length, 2, 'the rest must be surfaced as unresolved, not dropped')
})

test('questions are ordered by impact, highest first', () => {
  const plan = planQuestions({
    unknowns: [
      unknown({ itemId: 'small', itemName: 'curd', kcalSwing: 90 }),
      unknown({ itemId: 'big', itemName: 'dal', kcalSwing: 300 }),
    ],
    mealKcal: 700,
    mealProteinG: 30,
    known: EMPTY,
  })
  assert.equal(plan.ask[0]?.unknown.itemId, 'big')
})

test('ties break toward the less confident unknown', () => {
  const plan = planQuestions({
    unknowns: [
      unknown({ itemId: 'sure', kcalSwing: 200, confidence: 0.9 }),
      unknown({ itemId: 'unsure', kcalSwing: 200, confidence: 0.2 }),
    ],
    mealKcal: 700,
    mealProteinG: 30,
    known: EMPTY,
  })
  assert.equal(plan.ask[0]?.unknown.itemId, 'unsure')
})

test('R4 — an unknown this user already settled is never asked again', () => {
  const u = unknown({ itemName: 'dal', kind: 'portion' })
  const known = new Set([knownKey('Dal', 'portion')])
  const plan = planQuestions({ unknowns: [u], mealKcal: 600, mealProteinG: 25, known })
  assert.equal(plan.ask.length, 0)
  assert.equal(plan.unresolved.length, 0)
  assert.equal(plan.ignored.length, 0, 'a known answer is not an ignored unknown')
})

test('knownKey is case and whitespace insensitive', () => {
  assert.equal(knownKey('  Dal Tadka ', 'portion'), knownKey('dal tadka', 'portion'))
})

test('protein swing alone can justify a question', () => {
  // Small calorie swing, large protein swing: paneer vs tofu.
  const u = unknown({
    kind: 'protein_source',
    itemName: 'paneer',
    kcalSwing: 20,
    proteinSwingG: 12,
    options: ['paneer', 'tofu'],
  })
  const plan = planQuestions({ unknowns: [u], mealKcal: 700, mealProteinG: 30, known: EMPTY })
  assert.equal(plan.ask.length, 1, 'protein must be able to drive the decision on its own')
})

test('impactOf uses the larger of the calorie and protein shares', () => {
  const u = unknown({ kcalSwing: 70, proteinSwingG: 15 })
  // kcal share 70/700 = 0.10 ; protein share 15/30 = 0.50
  assert.equal(impactOf(u, 700, 30), 0.5)
})

test('impactOf is safe when a total is zero', () => {
  assert.equal(impactOf(unknown(), 0, 0), 0)
})

test('the threshold is inclusive at the boundary', () => {
  // Isolate the calorie share: protein swing is zeroed so it cannot dominate.
  // Exactly at threshold is asked; just below is not.
  const at = unknown({ kcalSwing: 100, proteinSwingG: 0 })
  const below = unknown({ kcalSwing: 99, proteinSwingG: 0 })
  const atPlan = planQuestions({ unknowns: [at], mealKcal: 1000, mealProteinG: 50, known: EMPTY })
  const belowPlan = planQuestions({
    unknowns: [below],
    mealKcal: 1000,
    mealProteinG: 50,
    known: EMPTY,
  })
  assert.equal(impactOf(at, 1000, 50), IMPACT_THRESHOLD)
  assert.equal(atPlan.ask.length, 1)
  assert.equal(belowPlan.ask.length, 0)
})

test('question text uses household units, never grams', () => {
  const plan = planQuestions({
    unknowns: [unknown()],
    mealKcal: 600,
    mealProteinG: 25,
    known: EMPTY,
  })
  const text = plan.ask[0]?.text ?? ''
  assert.match(text, /katori/)
  assert.doesNotMatch(text, /gram|\bg\b/i)
})

test('planning is deterministic', () => {
  const input = {
    unknowns: [unknown({ itemId: 'a' }), unknown({ itemId: 'b', kcalSwing: 200 })],
    mealKcal: 700,
    mealProteinG: 30,
    known: EMPTY,
  }
  assert.deepEqual(planQuestions(input), planQuestions(input))
})
