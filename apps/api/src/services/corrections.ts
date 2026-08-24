/**
 * Corrections — R5, and the one that makes the moat real.
 *
 * Correcting is not editing a number. It is teaching. When someone says "that
 * was two katori, not one", three things must happen together:
 *
 *   1. The logged meal is fixed, so today's totals are right.
 *   2. Their personal version of that dish is updated, so it is right next time.
 *   3. The attribute is marked settled, so we never ask about it again.
 *
 * Doing only the first is what every other tracker does, and it is why their
 * databases never improve. A correction that does not teach is a chore.
 */

import { and, eq, sql } from 'drizzle-orm'
import { knownKey } from '@ogt/core'
import type { Database } from '../db/index.ts'
import { knownAttributes, mealItems, meals, userFoods } from '../db/schema.ts'
import { normalise } from './meal-log.ts'

const KCAL_PER_TSP_FAT = 40

export interface CorrectItemInput {
  db: Database
  userId: string
  mealId: string
  itemId: string
  units?: number
  cookingFat?: 'none' | 'oil' | 'ghee' | 'butter'
  cookingFatTsp?: number
  name?: string
}

export interface CorrectItemResult {
  mealId: string
  itemId: string
  /** Recomputed meal totals, so the client does not have to guess. */
  totals: { kcal: number; proteinG: number; carbG: number; fatG: number }
  /** True when this taught us something for next time. */
  learned: boolean
}

export async function correctMealItem(input: CorrectItemInput): Promise<CorrectItemResult> {
  return input.db.transaction(async (tx) => {
    // Scoped through the meal to the user: a meal-item id is guessable, and
    // letting someone edit a row they do not own would be worse than a leak.
    const [row] = await tx
      .select({ item: mealItems, meal: meals })
      .from(mealItems)
      .innerJoin(meals, eq(mealItems.mealId, meals.id))
      .where(
        and(
          eq(mealItems.id, input.itemId),
          eq(mealItems.mealId, input.mealId),
          eq(meals.userId, input.userId),
        ),
      )
      .limit(1)

    if (!row) throw new Error('No such item on a meal of yours')

    const { item } = row

    const units = input.units ?? item.units
    const name = input.name?.trim() || item.name
    const cookingFat = input.cookingFat ?? item.cookingFat ?? null
    const cookingFatTsp =
      input.cookingFatTsp ?? (item.cookingFatTsp === null ? undefined : item.cookingFatTsp)

    // Recover per-100g values from the stored row so a correction to portion
    // rescales nutrition correctly. Stored grams already include the old units.
    const oldGrams = item.grams
    const perGramKcal = oldGrams > 0 ? (item.kcal - storedFatKcal(item)) / oldGrams : 0
    const perGramProtein = oldGrams > 0 ? item.proteinG / oldGrams : 0
    const perGramCarb = oldGrams > 0 ? item.carbG / oldGrams : 0
    const perGramFat = oldGrams > 0 ? (item.fatG - storedFatKcal(item) / 9) / oldGrams : 0

    const gramsPerUnit = item.units > 0 ? item.grams / item.units : item.grams
    const grams = units * gramsPerUnit
    const fatKcal =
      cookingFat && cookingFat !== 'none' ? (cookingFatTsp ?? 1) * KCAL_PER_TSP_FAT : 0

    const corrected = {
      kcal: perGramKcal * grams + fatKcal,
      proteinG: perGramProtein * grams,
      carbG: perGramCarb * grams,
      fatG: perGramFat * grams + fatKcal / 9,
    }

    await tx
      .update(mealItems)
      .set({
        name,
        units,
        grams,
        portionLabel: `${formatUnits(units)} ${item.portionLabel.split(' ').slice(1).join(' ') || 'serving'}`,
        kcal: corrected.kcal,
        proteinG: corrected.proteinG,
        carbG: corrected.carbG,
        fatG: corrected.fatG,
        ...(cookingFat ? { cookingFat } : {}),
        ...(cookingFatTsp !== undefined ? { cookingFatTsp } : {}),
        // A corrected item is confirmed by definition — the user just told us.
        confidence: 'confirmed',
      })
      .where(eq(mealItems.id, input.itemId))

    // Recompute the meal from its items rather than adjusting by a delta.
    // Deltas drift; a full recompute cannot.
    const siblings = await tx
      .select()
      .from(mealItems)
      .where(eq(mealItems.mealId, input.mealId))

    const totals = siblings.reduce(
      (acc, sibling) => ({
        kcal: acc.kcal + sibling.kcal,
        proteinG: acc.proteinG + sibling.proteinG,
        carbG: acc.carbG + sibling.carbG,
        fatG: acc.fatG + sibling.fatG,
      }),
      { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 },
    )

    await tx
      .update(meals)
      .set({ ...totals, correctedAt: new Date() })
      .where(eq(meals.id, input.mealId))

    // --- the part that matters: teach it ---

    const normalisedName = normalise(name)
    const perHundred = {
      kcalPer100g: perGramKcal * 100,
      proteinPer100g: perGramProtein * 100,
      carbPer100g: perGramCarb * 100,
      fatPer100g: perGramFat * 100,
    }

    await tx
      .insert(userFoods)
      .values({
        userId: input.userId,
        name,
        normalisedName,
        unit: item.portionLabel.split(' ').slice(1).join(' ') || 'serving',
        gramsPerUnit,
        ...perHundred,
        ...(cookingFat ? { cookingFat } : {}),
        ...(cookingFatTsp !== undefined ? { cookingFatTsp } : {}),
        usualUnits: units,
        timesLogged: 1,
        lastLoggedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userFoods.userId, userFoods.normalisedName],
        set: {
          gramsPerUnit: sql`excluded.grams_per_unit`,
          kcalPer100g: sql`excluded.kcal_per_100g`,
          proteinPer100g: sql`excluded.protein_per_100g`,
          carbPer100g: sql`excluded.carb_per_100g`,
          fatPer100g: sql`excluded.fat_per_100g`,
          cookingFat: sql`COALESCE(excluded.cooking_fat, ${userFoods.cookingFat})`,
          cookingFatTsp: sql`COALESCE(excluded.cooking_fat_tsp, ${userFoods.cookingFatTsp})`,
          usualUnits: sql`excluded.usual_units`,
          updatedAt: sql`now()`,
        },
      })

    // Settle the attributes they just corrected, so R4 stops asking.
    const settled: Array<{ userId: string; attributeKey: string; value: string; settledBy: string }> =
      []

    if (input.units !== undefined) {
      settled.push({
        userId: input.userId,
        attributeKey: knownKey(name, 'portion'),
        value: String(units),
        settledBy: 'corrected',
      })
    }
    if (input.cookingFat !== undefined) {
      settled.push({
        userId: input.userId,
        attributeKey: knownKey(name, 'cooking_fat'),
        value: input.cookingFat,
        settledBy: 'corrected',
      })
    }

    if (settled.length > 0) {
      await tx
        .insert(knownAttributes)
        .values(settled)
        .onConflictDoUpdate({
          target: [knownAttributes.userId, knownAttributes.attributeKey],
          set: {
            value: sql`excluded.value`,
            settledBy: sql`excluded.settled_by`,
            settledAt: sql`now()`,
          },
        })
    }

    return {
      mealId: input.mealId,
      itemId: input.itemId,
      totals,
      learned: settled.length > 0,
    }
  })
}

/** Cooking-fat calories baked into a stored row, so they can be stripped out. */
function storedFatKcal(item: { cookingFat: string | null; cookingFatTsp: number | null }): number {
  if (!item.cookingFat || item.cookingFat === 'none') return 0
  return (item.cookingFatTsp ?? 1) * KCAL_PER_TSP_FAT
}

function formatUnits(units: number): string {
  return Number.isInteger(units) ? String(units) : units.toFixed(1)
}
