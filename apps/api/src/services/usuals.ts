/**
 * "Your usual?" — feature 05.
 *
 * This is where R4 finally pays the user back. Answering questions in week one
 * only matters if week four is faster, and this is the mechanism: a meal you
 * have eaten before is one tap, with zero questions, because everything about
 * it is already settled.
 *
 * The demand for exactly this is unambiguous:
 *
 *   "They all require too much brain power between sets... The moment I have to
 *    think, my adherence collapses. I will happily pay full price every month.
 *    I just desperately want this product to exist."
 *
 * So the bar here is one tap and no thinking. A "usual" that needs confirming
 * is not a usual.
 */

import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { mealItems, meals } from '../db/schema.ts'
import { inferMealType } from './day.ts'
import { recordLoggedDay } from './streaks.ts'

export interface Usual {
  /** The meal this was learned from. Repeating clones it. */
  sourceMealId: string
  label: string
  kcal: number
  proteinG: number
  timesEaten: number
  lastEatenAt: Date
  mealType: string | null
  itemCount: number
}

/**
 * Meals this person eats repeatedly.
 *
 * Grouped by their item signature rather than by a name, because people do not
 * name their dinners — "dal + 2 roti + bhindi" is the same meal whether they
 * photographed it or typed it.
 */
export interface FindUsualsInput {
  db: Database
  userId: string
  /** Bias toward what they eat at this time of day. */
  at?: Date
  limit?: number
  /** How far back to learn from. */
  windowDays?: number
}

export async function findUsuals(input: FindUsualsInput): Promise<Usual[]> {
  const limit = input.limit ?? 5
  const windowDays = input.windowDays ?? 45
  const at = input.at ?? new Date()
  const since = new Date(at.getTime() - windowDays * 24 * 60 * 60 * 1000)

  const recent = await input.db
    .select()
    .from(meals)
    .where(and(eq(meals.userId, input.userId), gte(meals.eatenAt, since)))
    .orderBy(desc(meals.eatenAt))
    .limit(200)

  if (recent.length === 0) return []

  const itemRows = await input.db
    .select()
    .from(mealItems)
    .where(inArray(mealItems.mealId, recent.map((meal) => meal.id)))

  const itemsByMeal = new Map<string, typeof itemRows>()
  for (const item of itemRows) {
    const list = itemsByMeal.get(item.mealId) ?? []
    list.push(item)
    itemsByMeal.set(item.mealId, list)
  }

  interface Group {
    signature: string
    label: string
    meals: typeof recent
    itemCount: number
  }

  const groups = new Map<string, Group>()

  for (const meal of recent) {
    const items = itemsByMeal.get(meal.id) ?? []
    if (items.length === 0) continue

    const signature = signatureOf(items.map((item) => item.name))
    const existing = groups.get(signature)

    if (existing) {
      existing.meals.push(meal)
    } else {
      groups.set(signature, {
        signature,
        label: labelOf(items.map((item) => ({ name: item.name, portion: item.portionLabel }))),
        meals: [meal],
        itemCount: items.length,
      })
    }
  }

  const currentSlot = inferMealType(at)

  const usuals = [...groups.values()]
    .filter((group) => group.meals.length >= 2) // eaten once is not a usual
    .map((group) => {
      // Average across repeats rather than taking the latest: one unusually
      // large portion should not redefine what "your usual" means.
      const kcal = mean(group.meals.map((meal) => meal.kcal))
      const proteinG = mean(group.meals.map((meal) => meal.proteinG))
      const latest = group.meals[0]!

      return {
        sourceMealId: latest.id,
        label: group.label,
        kcal,
        proteinG,
        timesEaten: group.meals.length,
        lastEatenAt: latest.eatenAt,
        mealType: latest.mealType,
        itemCount: group.itemCount,
      }
    })
    .sort((a, b) => {
      // What they eat at this hour comes first; then how often; then recency.
      const aSlot = a.mealType === currentSlot ? 1 : 0
      const bSlot = b.mealType === currentSlot ? 1 : 0
      if (aSlot !== bSlot) return bSlot - aSlot
      if (a.timesEaten !== b.timesEaten) return b.timesEaten - a.timesEaten
      return b.lastEatenAt.getTime() - a.lastEatenAt.getTime()
    })

  return usuals.slice(0, limit)
}

/** Clone a previous meal as today's. No questions — everything is settled. */
export interface RepeatMealInput {
  db: Database
  userId: string
  sourceMealId: string
  at?: Date
  utcOffsetMinutes?: number
}

export interface RepeatMealResult {
  mealId: string
  kcal: number
  proteinG: number
  confidence: 'exact' | 'confirmed' | 'rough'
  streakDays: number
}

export async function repeatMeal(input: RepeatMealInput): Promise<RepeatMealResult> {
  const at = input.at ?? new Date()

  const created = await input.db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(meals)
      .where(and(eq(meals.id, input.sourceMealId), eq(meals.userId, input.userId)))
      .limit(1)

    // Scoped to the user deliberately: a meal id is guessable, and repeating
    // someone else's dinner would leak what they ate.
    if (!source) throw new Error('That meal is not yours, or no longer exists')

    const sourceItems = await tx
      .select()
      .from(mealItems)
      .where(eq(mealItems.mealId, source.id))

    const [created] = await tx
      .insert(meals)
      .values({
        userId: input.userId,
        mealType: inferMealType(at),
        eatenAt: at,
        kcal: source.kcal,
        proteinG: source.proteinG,
        carbG: source.carbG,
        fatG: source.fatG,
        confidence: source.confidence,
        source: 'repeat',
        // Zero. This is the number that proves R4 works, and a repeat is the
        // purest possible instance of it.
        questionsAsked: 0,
        questionsSkippedKnown: sourceItems.length,
      })
      .returning({ id: meals.id })

    if (!created) throw new Error('Could not log that meal')

    if (sourceItems.length > 0) {
      await tx.insert(mealItems).values(
        sourceItems.map((item) => ({
          mealId: created.id,
          name: item.name,
          portionLabel: item.portionLabel,
          units: item.units,
          grams: item.grams,
          kcal: item.kcal,
          proteinG: item.proteinG,
          carbG: item.carbG,
          fatG: item.fatG,
          ...(item.cookingFat ? { cookingFat: item.cookingFat } : {}),
          ...(item.cookingFatTsp !== null ? { cookingFatTsp: item.cookingFatTsp } : {}),
          modelConfidence: item.modelConfidence,
          confidence: item.confidence,
        })),
      )
    }

    return {
      mealId: created.id,
      kcal: source.kcal,
      proteinG: source.proteinG,
      confidence: source.confidence,
    }
  })

  // A repeat is still a logged day. Previously it was not counted, so the
  // fastest way to log — the one we most want people using — was the only one
  // that silently broke their streak.
  //
  // Outside the transaction deliberately: a streak-counter failure must never
  // roll back a logged meal.
  let streakDays = 0
  try {
    const advanced = await recordLoggedDay(input.db, input.userId, at, input.utcOffsetMinutes ?? 330)
    streakDays = advanced.currentDays
  } catch {
    // Swallowed. See above.
  }

  return { ...created, streakDays }
}

/** Order-independent identity for a set of dishes. */
export function signatureOf(names: readonly string[]): string {
  return [...names]
    .map((name) => name.trim().toLowerCase().replace(/\s+/g, ' '))
    .sort()
    .join('|')
}

/** "Dal, 2 roti and bhindi" — how a person would say it, not a list of rows. */
export function labelOf(items: ReadonlyArray<{ name: string; portion: string }>): string {
  const parts = items.slice(0, 3).map((item) => item.name)
  const extra = items.length - parts.length

  if (parts.length === 0) return 'Meal'
  if (parts.length === 1) return parts[0]!
  const head = parts.slice(0, -1).join(', ')
  const tail = parts[parts.length - 1]!
  const base = `${head} and ${tail}`
  return extra > 0 ? `${base} +${extra}` : base
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
