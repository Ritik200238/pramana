/**
 * The question planner. R1 and R2 in code.
 *
 * The vision model is forbidden from committing to a quantity - it returns
 * items with ranges and confidence. This module decides, deterministically,
 * which unknowns are worth asking the user about.
 *
 * The rule is impact, not uncertainty: we ask only when the answer moves the
 * calorie or protein total by more than the threshold. Onion versus no onion is
 * uncertain and irrelevant; ghee versus no ghee is 100+ kcal and gets asked.
 *
 * The cap of two is not a guess. Every extra question is friction, and friction
 * is the documented cause of abandonment: "the moment I have to think, my
 * adherence collapses". Two is what we spend; the rest we mark as rough.
 */

export const MAX_QUESTIONS = 2

/** An unknown must move the total by at least this share to be worth asking. */
export const IMPACT_THRESHOLD = 0.1

export type UnknownKind = 'portion' | 'cooking_fat' | 'protein_source' | 'preparation'

export interface Unknown {
  kind: UnknownKind
  /** Which recognised item this attaches to. */
  itemId: string
  itemName: string
  /** Worst-case kcal swing between the plausible answers. */
  kcalSwing: number
  /** Worst-case protein swing in grams. */
  proteinSwingG: number
  /** Model confidence for this specific attribute, 0-1. */
  confidence: number
  /** Answer options, in the household units a person actually uses. */
  options: readonly string[]
}

export interface Question {
  unknown: Unknown
  /** Rendered prompt. Short, concrete, answerable with one tap. */
  text: string
  /** Share of the meal total this answer swings. Drives ordering. */
  impact: number
}

export interface PlanInput {
  unknowns: readonly Unknown[]
  /** Running totals for the meal as currently estimated. */
  mealKcal: number
  mealProteinG: number
  /**
   * Attributes this user has already settled for these items, from their
   * personal food library. R4: anything in here is never asked again.
   */
  known: ReadonlySet<string>
}

export interface Plan {
  ask: Question[]
  /** Above threshold but beyond the cap. These force a 'rough' confidence label. */
  unresolved: Unknown[]
  /** Below threshold. Silently estimated; never shown as a question. */
  ignored: Unknown[]
  /**
   * Raised, worth asking, and not asked because this person already answered it
   * once. R4 skips these; they are still amounts the user settled.
   *
   * Kept apart from the rest because "we never asked" and "we asked once and
   * they told us" look identical from the question list and mean opposite
   * things about how much the number can be trusted.
   */
  settled: Unknown[]
}

/** Stable key for "this user has already answered this". */
export function knownKey(itemName: string, kind: UnknownKind): string {
  return `${itemName.trim().toLowerCase()}::${kind}`
}

/**
 * Relative impact of an unknown on the meal.
 *
 * Protein is weighted equal to calories despite being a smaller absolute
 * number, because protein is the number this product is built around. A 15 g
 * protein swing matters more to our user than a 60 kcal swing, and dividing
 * each by its own total is what expresses that.
 */
export function impactOf(u: Unknown, mealKcal: number, mealProteinG: number): number {
  const kcalShare = mealKcal > 0 ? u.kcalSwing / mealKcal : 0
  const proteinShare = mealProteinG > 0 ? u.proteinSwingG / mealProteinG : 0
  return Math.max(kcalShare, proteinShare)
}

export function planQuestions(input: PlanInput): Plan {
  const ignored: Unknown[] = []
  const settled: Unknown[] = []
  const candidates: Question[] = []

  for (const unknown of input.unknowns) {
    // R4 — already settled for this user. Never ask twice, but remember that
    // they did answer it, because that is what makes the number theirs.
    if (input.known.has(knownKey(unknown.itemName, unknown.kind))) {
      settled.push(unknown)
      continue
    }

    const impact = impactOf(unknown, input.mealKcal, input.mealProteinG)
    if (impact < IMPACT_THRESHOLD) {
      ignored.push(unknown)
      continue
    }
    candidates.push({ unknown, impact, text: renderQuestion(unknown) })
  }

  // Highest impact first; break ties by lowest confidence, since a confident
  // guess is likelier to be right than an unconfident one of equal swing.
  candidates.sort((a, b) => b.impact - a.impact || a.unknown.confidence - b.unknown.confidence)

  return {
    ask: candidates.slice(0, MAX_QUESTIONS),
    unresolved: candidates.slice(MAX_QUESTIONS).map((q) => q.unknown),
    ignored,
    settled,
  }
}

/**
 * Phrasing. Household units, never grams - "1 katori or 2" is answerable in a
 * second; "how many grams of dal" is not, and asking it is how tracking apps
 * lose people.
 */
function renderQuestion(u: Unknown): string {
  const options = u.options.join(' or ')
  switch (u.kind) {
    case 'portion':
      return `How much ${u.itemName.toLowerCase()} — ${options}?`
    case 'cooking_fat':
      return `${capitalise(u.itemName)} — ${options}?`
    case 'protein_source':
      return `Is that ${options}?`
    case 'preparation':
      return `${capitalise(u.itemName)} — ${options}?`
  }
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}
