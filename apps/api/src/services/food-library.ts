/**
 * Food search — feature 08, the read side of R5.
 *
 * The rule that matters: **a user's own entry always outranks the shared
 * database.** Correcting "dal tadka" once means every later search returns
 * *your* dal, with your ghee and your portion, and never again offers you the
 * six contradictory public entries that made people give up:
 *
 *   "'dal tadka' gave 6 different entries with wildly different calories."
 *   "values seem to be random guesses, with a bias towards lowball,
 *    guilt-assuaging numbers."
 *
 * Global rows are reference data and are never edited by a correction. That is
 * deliberate: shared data everyone can rewrite is how the incumbents' databases
 * became untrustworthy in the first place.
 */

import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { globalFoods, userFoods } from '../db/schema.ts'
import { normalise } from './meal-log.ts'

export interface FoodMatch {
  source: 'user' | 'global'
  id: string
  name: string
  unit: string
  gramsPerUnit: number
  kcalPer100g: number
  proteinPer100g: number
  carbPer100g: number
  fatPer100g: number
  /** Present only on personal entries: their kitchen's settled answers. */
  cookingFat?: 'none' | 'oil' | 'ghee' | 'butter' | null
  cookingFatTsp?: number | null
  usualUnits?: number | null
  timesLogged?: number
  /** Whether cooking fat materially changes this dish. Feeds the question planner. */
  fatVaries: boolean
}

export interface SearchInput {
  db: Database
  userId: string
  query: string
  limit?: number
}

/**
 * Search personal entries first, then fall back to global reference data.
 *
 * Two queries rather than one union, because the ranking is not a scoring
 * question — a personal entry beats a global one unconditionally, however good
 * the text match on the global row happens to be.
 */
export async function searchFoods(input: SearchInput): Promise<FoodMatch[]> {
  const limit = input.limit ?? 8
  const term = input.query.trim()
  if (term.length === 0) return []

  const pattern = `%${term}%`

  const mine = await input.db
    .select()
    .from(userFoods)
    .where(and(eq(userFoods.userId, input.userId), ilike(userFoods.name, pattern)))
    .orderBy(desc(userFoods.timesLogged))
    .limit(limit)

  const matches: FoodMatch[] = mine.map((food) => ({
    source: 'user',
    id: food.id,
    name: food.name,
    unit: food.unit,
    gramsPerUnit: food.gramsPerUnit,
    kcalPer100g: food.kcalPer100g,
    proteinPer100g: food.proteinPer100g,
    carbPer100g: food.carbPer100g,
    fatPer100g: food.fatPer100g,
    cookingFat: food.cookingFat,
    cookingFatTsp: food.cookingFatTsp,
    usualUnits: food.usualUnits,
    timesLogged: food.timesLogged,
    // A settled cooking fat means the question is answered for this dish.
    fatVaries: food.cookingFat === null,
  }))

  if (matches.length >= limit) return matches

  const mineNames = new Set(mine.map((food) => normalise(food.name)))

  const shared = await input.db
    .select()
    .from(globalFoods)
    .where(
      or(
        ilike(globalFoods.name, pattern),
        // Hindi, regional and colloquial names for the same dish. This is the
        // synonym mapping whose absence users called out by name.
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${globalFoods.aliases}) AS alias
          WHERE alias ILIKE ${pattern}
        )`,
      ),
    )
    .limit(limit * 2)

  for (const food of shared) {
    if (matches.length >= limit) break
    // Never show the public version of a dish the user has already made theirs.
    if (mineNames.has(normalise(food.name))) continue

    matches.push({
      source: 'global',
      id: food.id,
      name: food.name,
      unit: food.unit,
      gramsPerUnit: food.gramsPerUnit,
      kcalPer100g: food.kcalPer100g,
      proteinPer100g: food.proteinPer100g,
      carbPer100g: food.carbPer100g,
      fatPer100g: food.fatPer100g,
      fatVaries: food.fatVaries,
    })
  }

  return matches
}

export interface UpsertUserFoodInput {
  db: Database
  userId: string
  name: string
  unit: string
  gramsPerUnit: number
  kcalPer100g: number
  proteinPer100g: number
  carbPer100g: number
  fatPer100g: number
  basedOnGlobalFoodId?: string
  cookingFat?: 'none' | 'oil' | 'ghee' | 'butter'
  cookingFatTsp?: number
  usualUnits?: number
}

/**
 * Create or update the user's own version of a dish. R5 in one call.
 *
 * Called on correction and on first log, so a dish becomes "theirs" the moment
 * they tell us anything specific about it.
 */
export async function upsertUserFood(input: UpsertUserFoodInput): Promise<string> {
  const normalisedName = normalise(input.name)

  const [row] = await input.db
    .insert(userFoods)
    .values({
      userId: input.userId,
      name: input.name.trim(),
      normalisedName,
      ...(input.basedOnGlobalFoodId ? { basedOnGlobalFoodId: input.basedOnGlobalFoodId } : {}),
      unit: input.unit,
      gramsPerUnit: input.gramsPerUnit,
      kcalPer100g: input.kcalPer100g,
      proteinPer100g: input.proteinPer100g,
      carbPer100g: input.carbPer100g,
      fatPer100g: input.fatPer100g,
      ...(input.cookingFat ? { cookingFat: input.cookingFat } : {}),
      ...(input.cookingFatTsp !== undefined ? { cookingFatTsp: input.cookingFatTsp } : {}),
      ...(input.usualUnits !== undefined ? { usualUnits: input.usualUnits } : {}),
    })
    .onConflictDoUpdate({
      target: [userFoods.userId, userFoods.normalisedName],
      set: {
        unit: sql`excluded.unit`,
        gramsPerUnit: sql`excluded.grams_per_unit`,
        kcalPer100g: sql`excluded.kcal_per_100g`,
        proteinPer100g: sql`excluded.protein_per_100g`,
        carbPer100g: sql`excluded.carb_per_100g`,
        fatPer100g: sql`excluded.fat_per_100g`,
        cookingFat: sql`COALESCE(excluded.cooking_fat, ${userFoods.cookingFat})`,
        cookingFatTsp: sql`COALESCE(excluded.cooking_fat_tsp, ${userFoods.cookingFatTsp})`,
        usualUnits: sql`COALESCE(excluded.usual_units, ${userFoods.usualUnits})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: userFoods.id })

  if (!row) throw new Error('Failed to save your version of this food')
  return row.id
}
