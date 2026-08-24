/**
 * The day view — feature 06.
 *
 * This backs the only screen most users will look at every day, so it answers
 * exactly one question: **how much protein is left today?**
 *
 * Calories are returned but deliberately secondary. "Am I getting enough
 * protein" is a question Indian users are already asking themselves; a calorie
 * ring is a dashboard, and dashboards are what people stop opening.
 *
 * There is no score here, and there will not be one. A composite number with no
 * published weighting cannot be argued with, which is precisely why people stop
 * looking at it — the documented mechanism behind wearable churn.
 */

import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import { computeTargets, rollUp, type Confidence, type Targets } from '@ogt/core'
import type { Database } from '../db/index.ts'
import { mealItems, meals, users, weightLogs } from '../db/schema.ts'

export interface DayMealItem {
  name: string
  portionLabel: string
  kcal: number
  proteinG: number
  confidence: Confidence
}

export interface DayMeal {
  id: string
  mealType: string | null
  eatenAt: Date
  kcal: number
  proteinG: number
  confidence: Confidence
  source: string
  questionsAsked: number
  items: DayMealItem[]
}

export interface DaySummary {
  date: string
  targets: Targets | null
  totals: { kcal: number; proteinG: number; carbG: number; fatG: number }
  proteinLeftG: number
  proteinPct: number
  caloriesLeft: number
  /** Weakest link across the day. A day is only as honest as its softest entry. */
  confidence: Confidence
  mealCount: number
  meals: DayMeal[]
  /**
   * Mean questions asked per meal today. The thesis metric, surfaced so it can
   * be watched from day one rather than reconstructed later from analytics.
   */
  questionsPerMeal: number
}

/** Local-day bounds. Meals belong to the day the person ate them, not to UTC. */
export function dayBounds(reference: Date, offsetMinutes: number): { from: Date; to: Date } {
  // Shift into local time to read off the local calendar date...
  const local = new Date(reference.getTime() + offsetMinutes * 60_000)
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    0,
    0,
    0,
    0,
  )
  // ...then shift back, so `from` is the UTC instant of local midnight.
  const from = new Date(localMidnight - offsetMinutes * 60_000)
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)
  return { from, to }
}

export interface DaySummaryInput {
  db: Database
  userId: string
  /** Minutes east of UTC. India is +330. */
  utcOffsetMinutes?: number
  now?: Date
}

export async function getDaySummary(input: DaySummaryInput): Promise<DaySummary> {
  const now = input.now ?? new Date()
  const offset = input.utcOffsetMinutes ?? 330
  const { from, to } = dayBounds(now, offset)

  const [user] = await input.db.select().from(users).where(eq(users.id, input.userId)).limit(1)

  const [latestWeight] = await input.db
    .select({ weightKg: weightLogs.weightKg })
    .from(weightLogs)
    .where(eq(weightLogs.userId, input.userId))
    .orderBy(desc(weightLogs.recordedAt))
    .limit(1)

  let targets: Targets | null = null
  if (user?.sex && user.ageYears && user.heightCm && user.activity && user.goal && latestWeight) {
    targets = computeTargets({
      sex: user.sex,
      ageYears: user.ageYears,
      heightCm: user.heightCm,
      weightKg: latestWeight.weightKg,
      activity: user.activity,
      goal: user.goal,
      ...(user.paceKgPerWeek ? { paceKgPerWeek: user.paceKgPerWeek } : {}),
    })
  }

  const mealRows = await input.db
    .select()
    .from(meals)
    .where(and(eq(meals.userId, input.userId), gte(meals.eatenAt, from), lt(meals.eatenAt, to)))
    .orderBy(asc(meals.eatenAt))

  const mealIds = mealRows.map((meal) => meal.id)
  const itemRows =
    mealIds.length > 0
      ? await input.db.select().from(mealItems).where(inArray(mealItems.mealId, mealIds))
      : []

  const itemsByMeal = new Map<string, DayMealItem[]>()
  for (const item of itemRows) {
    const list = itemsByMeal.get(item.mealId) ?? []
    list.push({
      name: item.name,
      portionLabel: item.portionLabel,
      kcal: item.kcal,
      proteinG: item.proteinG,
      confidence: item.confidence,
    })
    itemsByMeal.set(item.mealId, list)
  }

  const totals = mealRows.reduce(
    (acc, meal) => ({
      kcal: acc.kcal + meal.kcal,
      proteinG: acc.proteinG + meal.proteinG,
      carbG: acc.carbG + meal.carbG,
      fatG: acc.fatG + meal.fatG,
    }),
    { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 },
  )

  const questionTotal = mealRows.reduce((sum, meal) => sum + meal.questionsAsked, 0)

  return {
    date: from.toISOString().slice(0, 10),
    targets,
    totals,
    proteinLeftG: targets ? Math.max(0, Math.round(targets.proteinG - totals.proteinG)) : 0,
    proteinPct: targets
      ? Math.min(100, Math.round((totals.proteinG / targets.proteinG) * 100))
      : 0,
    caloriesLeft: targets ? Math.round(targets.calories - totals.kcal) : 0,
    confidence: rollUp(mealRows.map((meal) => meal.confidence)),
    mealCount: mealRows.length,
    meals: mealRows.map((meal) => ({
      id: meal.id,
      mealType: meal.mealType,
      eatenAt: meal.eatenAt,
      kcal: meal.kcal,
      proteinG: meal.proteinG,
      confidence: meal.confidence,
      source: meal.source,
      questionsAsked: meal.questionsAsked,
      items: itemsByMeal.get(meal.id) ?? [],
    })),
    questionsPerMeal: mealRows.length === 0 ? 0 : questionTotal / mealRows.length,
  }
}

/**
 * Which meal slot are we in?
 *
 * Used to label a log and to time nudges. Defaults are Indian-typical and get
 * overridden per user by their observed logging times.
 */
export function inferMealType(
  at: Date,
  offsetMinutes = 330,
): 'breakfast' | 'lunch' | 'dinner' | 'snack' {
  const local = new Date(at.getTime() + offsetMinutes * 60_000)
  const hour = local.getUTCHours()
  if (hour >= 5 && hour < 11) return 'breakfast'
  if (hour >= 11 && hour < 16) return 'lunch'
  if (hour >= 19 && hour < 24) return 'dinner'
  return 'snack'
}
