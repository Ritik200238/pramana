/**
 * Meal logging — where the whole thesis actually executes.
 *
 * Flow:
 *   photo -> model reads items + unknowns (never a committed quantity)
 *         -> known attributes loaded for this user            (R4)
 *         -> deterministic planner picks at most two questions (R1, R2)
 *         -> user answers
 *         -> totals computed, confidence classified            (R3)
 *         -> answers persisted as known attributes             (R4, R5)
 *
 * The metric that decides whether this product has a reason to exist —
 * questions asked per logged meal, falling below 0.3 by week four — is recorded
 * on every meal row here. It is not an analytics afterthought; it is the
 * experiment.
 */

import { eq, sql } from 'drizzle-orm'
import {
  classify,
  knownKey,
  planQuestions,
  rollUp,
  type Confidence,
  type Plan,
  type Unknown,
} from '@ogt/core'
import type { Database } from '../db/index.ts'
import { knownAttributes, mealItems, meals, userFoods } from '../db/schema.ts'
import { midpointEstimate, toPlannerUnknowns, type VisionItem, type VisionResult } from '../pipeline/meal-vision.ts'
import { recordLoggedDay } from './streaks.ts'
import { inferMealType } from './day.ts'

export interface DraftItem {
  id: string
  name: string
  unit: string
  units: number
  gramsPerUnit: number
  kcalPer100g: number
  proteinPer100g: number
  carbPer100g: number
  fatPer100g: number
  modelConfidence: number
  cookingFat?: 'none' | 'oil' | 'ghee' | 'butter'
  cookingFatTsp?: number
}

export interface MealDraft {
  items: DraftItem[]
  plan: Plan
  /** Unknowns skipped because this user already settled them. Drives the decay metric. */
  skippedKnown: number
  totals: { kcal: number; proteinG: number; carbG: number; fatG: number }
}

/** Everything this user has already settled. Loaded once per draft. */
export async function loadKnownAttributes(
  db: Database,
  userId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ key: knownAttributes.attributeKey })
    .from(knownAttributes)
    .where(eq(knownAttributes.userId, userId))

  return new Set(rows.map((row) => row.key))
}

/**
 * Turn a model reading into a draft with a question plan.
 *
 * `known` is passed in rather than fetched here so this stays pure and
 * testable — the decay behaviour is the thing most worth testing and it should
 * not need a database to verify.
 */
export function buildDraft(vision: VisionResult, known: ReadonlySet<string>): MealDraft {
  const items: DraftItem[] = vision.items.map((item) => {
    const midpoint = midpointEstimate(item)
    return {
      id: item.id,
      name: item.name,
      unit: item.unit,
      units: midpoint.units,
      gramsPerUnit: item.gramsPerUnit,
      kcalPer100g: item.kcalPer100g,
      proteinPer100g: item.proteinPer100g,
      carbPer100g: item.carbPer100g,
      fatPer100g: item.fatPer100g,
      modelConfidence: item.confidence,
    }
  })

  const totals = totalsOf(items)
  const allUnknowns = toPlannerUnknowns(vision)

  const plan = planQuestions({
    unknowns: allUnknowns,
    mealKcal: totals.kcal,
    mealProteinG: totals.proteinG,
    known,
  })

  return {
    items,
    plan,
    skippedKnown: countSkipped(allUnknowns, known),
    totals,
  }
}

function countSkipped(unknowns: readonly Unknown[], known: ReadonlySet<string>): number {
  return unknowns.filter((unknown) => known.has(knownKey(unknown.itemName, unknown.kind))).length
}

export function totalsOf(items: readonly DraftItem[]): {
  kcal: number
  proteinG: number
  carbG: number
  fatG: number
} {
  return items.reduce(
    (acc, item) => {
      const per = (item.units * item.gramsPerUnit) / 100
      const fatKcal = cookingFatKcal(item)
      return {
        kcal: acc.kcal + item.kcalPer100g * per + fatKcal,
        proteinG: acc.proteinG + item.proteinPer100g * per,
        carbG: acc.carbG + item.carbPer100g * per,
        fatG: acc.fatG + item.fatPer100g * per + fatKcal / 9,
      }
    },
    { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 },
  )
}

/**
 * Added cooking fat, in kcal.
 *
 * ~1 tsp of ghee or oil is about 4.5 g of fat, so roughly 40 kcal. This is the
 * number that makes roti-with-ghee and roti-without different foods, and it is
 * why `cooking_fat` is a first-class field rather than a note.
 */
const KCAL_PER_TSP_FAT = 40

export function cookingFatKcal(item: DraftItem): number {
  if (!item.cookingFat || item.cookingFat === 'none') return 0
  return (item.cookingFatTsp ?? 1) * KCAL_PER_TSP_FAT
}

export interface AnswerInput {
  itemId: string
  kind: 'portion' | 'cooking_fat' | 'protein_source' | 'preparation'
  /** The chosen option, verbatim from what was offered. */
  answer: string
  /** Parsed numeric portion where the answer is a count. */
  units?: number
  cookingFat?: 'none' | 'oil' | 'ghee' | 'butter'
  cookingFatTsp?: number
  /**
   * Corrected per-100g nutrition, when the answer changes what the food IS.
   *
   * Paneer and tofu are not the same food with a different label — they differ
   * by roughly 10g of protein per 100g. Without this, asking "paneer or tofu?"
   * would record the answer and change nothing, which is worse than not asking:
   * the user pays the friction and gets none of the accuracy.
   */
  nutrition?: {
    name?: string
    kcalPer100g: number
    proteinPer100g: number
    carbPer100g: number
    fatPer100g: number
  }
}

/** Apply the user's answers to a draft. */
export function applyAnswers(draft: MealDraft, answers: readonly AnswerInput[]): MealDraft {
  const items = draft.items.map((item) => {
    const forItem = answers.filter((answer) => answer.itemId === item.id)
    if (forItem.length === 0) return item

    let next: DraftItem = { ...item }
    for (const answer of forItem) {
      if (answer.kind === 'portion' && typeof answer.units === 'number') {
        next = { ...next, units: answer.units }
      }
      if (answer.kind === 'cooking_fat' && answer.cookingFat) {
        next = {
          ...next,
          cookingFat: answer.cookingFat,
          ...(answer.cookingFatTsp !== undefined ? { cookingFatTsp: answer.cookingFatTsp } : {}),
        }
      }
      // protein_source and preparation change the food itself, so they must
      // change its nutrition — otherwise the question was pure friction.
      if (
        (answer.kind === 'protein_source' || answer.kind === 'preparation') &&
        answer.nutrition
      ) {
        next = {
          ...next,
          ...(answer.nutrition.name ? { name: answer.nutrition.name } : {}),
          kcalPer100g: answer.nutrition.kcalPer100g,
          proteinPer100g: answer.nutrition.proteinPer100g,
          carbPer100g: answer.nutrition.carbPer100g,
          fatPer100g: answer.nutrition.fatPer100g,
        }
      }
    }
    return next
  })

  return { ...draft, items, totals: totalsOf(items) }
}

/**
 * R3 — classify what we actually know.
 *
 * A meal is only `confirmed` when every question worth asking was answered.
 * Unresolved unknowns above the impact threshold force `rough`, because a
 * number we could not pin down must not wear the same badge as one we could.
 */
export function classifyMeal(
  draft: MealDraft,
  answers: readonly AnswerInput[],
  fromBarcode = false,
): { itemConfidences: Confidence[]; mealConfidence: Confidence } {
  const answeredKeys = new Set(answers.map((answer) => `${answer.itemId}::${answer.kind}`))
  const askedKeys = new Set(
    draft.plan.ask.map((question) => `${question.unknown.itemId}::${question.unknown.kind}`),
  )
  const allAskedAnswered = [...askedKeys].every((key) => answeredKeys.has(key))
  const noneUnresolved = draft.plan.unresolved.length === 0

  const itemConfidences = draft.items.map((item) =>
    classify({
      fromBarcode,
      allSignificantAnswered: allAskedAnswered && noneUnresolved,
      minItemConfidence: item.modelConfidence,
    }),
  )

  return { itemConfidences, mealConfidence: rollUp(itemConfidences) }
}

export interface CommitInput {
  db: Database
  userId: string
  draft: MealDraft
  answers: readonly AnswerInput[]
  mealType?: 'breakfast' | 'lunch' | 'dinner' | 'snack'
  eatenAt?: Date
  source: 'photo' | 'text' | 'voice' | 'repeat'
  model?: string
  failovers?: number
}

export interface CommitResult {
  mealId: string
  totals: { kcal: number; proteinG: number; carbG: number; fatG: number }
  confidence: Confidence
  questionsAsked: number
}

/**
 * Persist a meal, and — critically — persist the answers as known attributes so
 * the same questions are never asked again. That write is what makes the
 * question count decay; without it the product is just a slower tracker.
 */
export async function commitMeal(input: CommitInput): Promise<CommitResult> {
  const { itemConfidences, mealConfidence } = classifyMeal(input.draft, input.answers)
  const totals = input.draft.totals

  return input.db.transaction(async (tx) => {
    const [meal] = await tx
      .insert(meals)
      .values({
        userId: input.userId,
        // Inferred when not given, so meals are always slotted. Usuals rank by
        // time of day, and a null slot makes "your usual" ignore breakfast.
        mealType: input.mealType ?? inferMealType(input.eatenAt ?? new Date()),
        ...(input.eatenAt ? { eatenAt: input.eatenAt } : {}),
        kcal: totals.kcal,
        proteinG: totals.proteinG,
        carbG: totals.carbG,
        fatG: totals.fatG,
        confidence: mealConfidence,
        source: input.source,
        ...(input.model ? { model: input.model } : {}),
        failovers: input.failovers ?? 0,
        questionsAsked: input.draft.plan.ask.length,
        questionsSkippedKnown: input.draft.skippedKnown,
      })
      .returning({ id: meals.id })

    if (!meal) throw new Error('Failed to insert meal')

    await tx.insert(mealItems).values(
      input.draft.items.map((item, index) => {
        const grams = item.units * item.gramsPerUnit
        const per = grams / 100
        const fatKcal = cookingFatKcal(item)
        return {
          mealId: meal.id,
          name: item.name,
          portionLabel: `${formatUnits(item.units)} ${item.unit}`,
          units: item.units,
          grams,
          kcal: item.kcalPer100g * per + fatKcal,
          proteinG: item.proteinPer100g * per,
          carbG: item.carbPer100g * per,
          fatG: item.fatPer100g * per + fatKcal / 9,
          ...(item.cookingFat ? { cookingFat: item.cookingFat } : {}),
          ...(item.cookingFatTsp !== undefined ? { cookingFatTsp: item.cookingFatTsp } : {}),
          modelConfidence: item.modelConfidence,
          confidence: itemConfidences[index] ?? 'rough',
        }
      }),
    )

    // R4 — settle these attributes permanently for this user.
    const itemNameById = new Map(input.draft.items.map((item) => [item.id, item.name]))
    const settled = input.answers.flatMap((answer) => {
      const name = itemNameById.get(answer.itemId)
      if (name === undefined) return []
      return [
        {
          userId: input.userId,
          attributeKey: knownKey(name, answer.kind),
          value: answer.answer,
          settledBy: 'answered',
        },
      ]
    })

    if (settled.length > 0) {
      await tx
        .insert(knownAttributes)
        .values(settled)
        .onConflictDoUpdate({
          target: [knownAttributes.userId, knownAttributes.attributeKey],
          set: { value: sql`excluded.value`, settledAt: sql`now()` },
        })
    }

    // R5 — this dish becomes THEIRS.
    //
    // Previously this only updated rows that never existed, because nothing
    // created them: the personal library was permanently empty and the whole
    // compounding moat was inert. Upserting here means the first time you log
    // a dish it is yours, with your portion and your kitchen's cooking fat.
    for (const item of input.draft.items) {
      await tx
        .insert(userFoods)
        .values({
          userId: input.userId,
          name: item.name,
          normalisedName: normalise(item.name),
          unit: item.unit,
          gramsPerUnit: item.gramsPerUnit,
          kcalPer100g: item.kcalPer100g,
          proteinPer100g: item.proteinPer100g,
          carbPer100g: item.carbPer100g,
          fatPer100g: item.fatPer100g,
          ...(item.cookingFat ? { cookingFat: item.cookingFat } : {}),
          ...(item.cookingFatTsp !== undefined ? { cookingFatTsp: item.cookingFatTsp } : {}),
          usualUnits: item.units,
          timesLogged: 1,
          lastLoggedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [userFoods.userId, userFoods.normalisedName],
          set: {
            timesLogged: sql`${userFoods.timesLogged} + 1`,
            lastLoggedAt: sql`now()`,
            usualUnits: item.units,
            // Only overwrite a settled cooking fat when this log actually
            // carries one; a photo without the question answered must not
            // erase what they told us last week.
            cookingFat: sql`COALESCE(excluded.cooking_fat, ${userFoods.cookingFat})`,
            cookingFatTsp: sql`COALESCE(excluded.cooking_fat_tsp, ${userFoods.cookingFatTsp})`,
            updatedAt: sql`now()`,
          },
        })
    }

    return {
      mealId: meal.id,
      totals,
      confidence: mealConfidence,
      questionsAsked: input.draft.plan.ask.length,
    }
  })
}

/**
 * Commit a meal and advance the streak.
 *
 * Separate from `commitMeal` so the streak write stays outside the meal
 * transaction: a streak-counter failure must never roll back a logged meal.
 * Losing a day of streak is an annoyance; losing the meal is the product
 * failing at its one job.
 */
export async function commitMealAndStreak(
  input: CommitInput & { utcOffsetMinutes?: number },
): Promise<CommitResult & { streakDays: number }> {
  const result = await commitMeal(input)

  let streakDays = 0
  try {
    const advanced = await recordLoggedDay(
      input.db,
      input.userId,
      input.eatenAt ?? new Date(),
      input.utcOffsetMinutes ?? 330,
    )
    streakDays = advanced.currentDays
  } catch {
    // Deliberately swallowed. See above.
  }

  return { ...result, streakDays }
}

export function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function formatUnits(units: number): string {
  return Number.isInteger(units) ? String(units) : units.toFixed(1)
}

/** Bridge so callers can build a draft item directly from a model item. */
export function draftItemFrom(item: VisionItem): DraftItem {
  const midpoint = midpointEstimate(item)
  return {
    id: item.id,
    name: item.name,
    unit: item.unit,
    units: midpoint.units,
    gramsPerUnit: item.gramsPerUnit,
    kcalPer100g: item.kcalPer100g,
    proteinPer100g: item.proteinPer100g,
    carbPer100g: item.carbPer100g,
    fatPer100g: item.fatPer100g,
    modelConfidence: item.confidence,
  }
}
