/**
 * Deterministic nutrition targets.
 *
 * Nothing in this file may be delegated to a model. These numbers drive what we
 * tell a person to eat every day, so they must be reproducible, auditable, and
 * bounded. The model layer only ever *explains* what this file computes.
 */

export type Sex = 'male' | 'female'
export type Goal = 'lose' | 'gain' | 'maintain' | 'recomp'
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active'

export interface UserProfile {
  sex: Sex
  ageYears: number
  heightCm: number
  weightKg: number
  activity: ActivityLevel
  goal: Goal
  /** Optional user-chosen pace in kg/week. Clamped to a safe range. */
  paceKgPerWeek?: number
}

export interface Targets {
  bmr: number
  tdee: number
  calories: number
  proteinG: number
  fatG: number
  carbG: number
  /** Populated whenever a requested value was clamped by a safety rule. */
  safetyNotes: string[]
}

const ACTIVITY_MULTIPLIER: Readonly<Record<ActivityLevel, number>> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
}

/** Absolute intake floors. We refuse to plan below these regardless of the request. */
const CALORIE_FLOOR: Readonly<Record<Sex, number>> = { female: 1200, male: 1500 }

/** Adjustment is also capped as a fraction of TDEE, independently of the floors. */
const MAX_DEFICIT_FRACTION = 0.25
const MAX_SURPLUS_FRACTION = 0.2

/** ~7700 kcal per kg of body mass. */
const KCAL_PER_KG = 7700
const MAX_LOSS_KG_PER_WEEK = 0.75
const MAX_GAIN_KG_PER_WEEK = 0.5

/**
 * Protein in g per kg bodyweight. Higher in a deficit to protect lean mass, and
 * the number this product is built around - Indian vegetarian diets are
 * routinely carb-dominant and protein-poor.
 */
const PROTEIN_G_PER_KG: Readonly<Record<Goal, number>> = {
  lose: 2.0,
  recomp: 2.0,
  gain: 1.8,
  maintain: 1.6,
}

const FAT_G_PER_KG_FLOOR = 0.8
const MIN_CARB_G = 50

/** Mifflin-St Jeor. The best-validated general BMR estimator. */
export function basalMetabolicRate(p: UserProfile): number {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.ageYears
  return p.sex === 'male' ? base + 5 : base - 161
}

export function bmi(weightKg: number, heightCm: number): number {
  const metres = heightCm / 100
  return weightKg / (metres * metres)
}

export function computeTargets(p: UserProfile): Targets {
  const notes: string[] = []
  const bmrValue = basalMetabolicRate(p)
  const tdee = bmrValue * ACTIVITY_MULTIPLIER[p.activity]

  const goalCalories = applyGoalAdjustment(tdee, p, notes)
  const proteinG = Math.round(PROTEIN_G_PER_KG[p.goal] * p.weightKg)
  const fatG = Math.round(Math.max(FAT_G_PER_KG_FLOOR * p.weightKg, (goalCalories * 0.25) / 9))

  // Carbohydrate absorbs the remainder. If protein and fat alone overshoot the
  // budget - possible at high bodyweight with a low target - we raise calories
  // rather than prescribe near-zero carbohydrate.
  const proteinKcal = proteinG * 4
  const fatKcal = fatG * 9
  let calories = goalCalories
  let carbG = Math.round((calories - proteinKcal - fatKcal) / 4)

  if (carbG < MIN_CARB_G) {
    calories = proteinKcal + fatKcal + MIN_CARB_G * 4
    carbG = MIN_CARB_G
    notes.push('Calories raised to fit protein, fat, and a minimum carbohydrate allowance.')
  }

  return {
    bmr: Math.round(bmrValue),
    tdee: Math.round(tdee),
    calories: Math.round(calories),
    proteinG,
    fatG,
    carbG,
    safetyNotes: notes,
  }
}

function applyGoalAdjustment(tdee: number, p: UserProfile, notes: string[]): number {
  if (p.goal === 'maintain') return tdee

  if (p.goal === 'recomp') {
    // Recomposition is driven by protein and training, not by a large cut.
    return clampToFloor(tdee * 0.95, p, notes)
  }

  const direction = p.goal === 'lose' ? -1 : 1
  const maxPace = p.goal === 'lose' ? MAX_LOSS_KG_PER_WEEK : MAX_GAIN_KG_PER_WEEK
  const requested = p.paceKgPerWeek ?? (p.goal === 'lose' ? 0.5 : 0.25)

  let pace = requested
  if (pace > maxPace) {
    pace = maxPace
    notes.push(
      `Pace limited to ${maxPace} kg/week. Faster than this costs muscle and rarely lasts.`,
    )
  }

  const dailyDelta = (pace * KCAL_PER_KG) / 7
  let target = tdee + direction * dailyDelta

  const maxFraction = p.goal === 'lose' ? MAX_DEFICIT_FRACTION : MAX_SURPLUS_FRACTION
  const bound = p.goal === 'lose' ? tdee * (1 - maxFraction) : tdee * (1 + maxFraction)
  const exceeded = p.goal === 'lose' ? target < bound : target > bound
  if (exceeded) {
    target = bound
    notes.push(`Adjustment capped at ${Math.round(maxFraction * 100)}% of maintenance.`)
  }

  return clampToFloor(target, p, notes)
}

function clampToFloor(target: number, p: UserProfile, notes: string[]): number {
  const floor = CALORIE_FLOOR[p.sex]
  if (target < floor) {
    notes.push(
      `Target raised to the ${floor} kcal minimum. Eating below this is not something this ` +
        'app will plan for.',
    )
    return floor
  }
  return target
}
