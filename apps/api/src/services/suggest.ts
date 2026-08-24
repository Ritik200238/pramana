/**
 * "What should I eat right now?" — feature 10.
 *
 * The complaint this answers is precise, and it is about follow-through rather
 * than knowledge:
 *
 *   "they just make ur diet plan n leave it to u... they are not even bothered
 *    what is working for u n what is not."
 *
 * So this does not generate a plan. It answers one question, once, for the next
 * meal, using what is actually in front of the person: their kitchen, their mess
 * menu, or the restaurant they are sitting in — and how much protein they still
 * need today.
 *
 * The most-liked request on this in the research was exactly that:
 *   "tell Chat the things in my frig or cabinet I need to use so it's cycling
 *    thru some stuff I already have on hand"
 */

import { eq } from 'drizzle-orm'
import type OpenAI from 'openai'
import { complete } from '@ogt/og'
import type { AttestationReceipt } from '@ogt/og'
import type { Database } from '../db/index.ts'
import { households, users } from '../db/schema.ts'
import { getDaySummary, inferMealType } from './day.ts'
import { findUsuals } from './usuals.ts'

const SYSTEM_PROMPT = `You answer one question: what should this person eat for their next meal, right now.

Rules:
- Suggest only from what they told you is available. If they gave a mess menu, pick from the menu. If they listed a kitchen, cook from that kitchen. If they are at a restaurant, choose from what they named.
- Two options at most, and say which you would pick.
- Lead with protein. Say how much protein the suggestion gives and what it leaves them short by, if anything.
- Respect their diet strictly. Vegetarian means no egg unless they said eggetarian. Jain means no onion, garlic, or root vegetables.
- If they cook for themselves, keep it to something makeable in about fifteen minutes unless they said otherwise.
- Be concrete: quantities in katori, roti, glass, plate.
- Three or four sentences. No preamble. No "great question".
- Never mention calories first. Protein first, calories second, and only if useful.`

export interface SuggestInput {
  db: Database
  client: OpenAI
  userId: string
  /** What is available right now, in their words. Overrides the stored pantry. */
  available?: string
  utcOffsetMinutes?: number
  now?: Date
}

export interface SuggestResult {
  text: string
  model: string
  proteinLeftG: number
  usage: { promptTokens: number; completionTokens: number; usd: number }
  /** Proof of where this ran. Travels with whatever it produced. */
  attestation: AttestationReceipt
}

export async function suggestMeal(input: SuggestInput): Promise<SuggestResult> {
  const now = input.now ?? new Date()
  const offset = input.utcOffsetMinutes ?? 330

  const [user] = await input.db.select().from(users).where(eq(users.id, input.userId)).limit(1)
  if (!user) throw new Error('User not found')

  const [household] = user.householdId
    ? await input.db.select().from(households).where(eq(households.id, user.householdId)).limit(1)
    : []

  const day = await getDaySummary({
    db: input.db,
    userId: input.userId,
    utcOffsetMinutes: offset,
    now,
  })

  // What they already eat is the strongest signal about what they will accept.
  // A suggestion outside their actual repertoire gets ignored, however optimal.
  const usuals = await findUsuals({ db: input.db, userId: input.userId, at: now, limit: 4 })

  const kitchen =
    input.available?.trim() ||
    (household?.pantry.length ? household.pantry.join(', ') : '') ||
    'not specified'

  const context = [
    `Meal slot: ${inferMealType(now, offset)}`,
    `Diet: ${user.diet ?? 'not set'}`,
    `Who cooks: ${user.cooks ?? 'not set'}`,
    `Goal: ${user.goal ?? 'not set'}`,
    day.targets
      ? `Protein today: ${Math.round(day.totals.proteinG)}g of ${day.targets.proteinG}g. ${day.proteinLeftG}g still needed.`
      : 'Protein target: not set.',
    day.targets ? `Calories today: ${Math.round(day.totals.kcal)} of ${day.targets.calories}.` : '',
    `Available right now: ${kitchen}`,
    usuals.length > 0
      ? `They often eat: ${usuals.map((usual) => usual.label).join('; ')}`
      : 'No repeat meals learned yet.',
    `Tone: ${user.tone}`,
  ]
    .filter(Boolean)
    .join('\n')

  const result = await complete(input.client, {
    task: 'coach',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: context },
    ],
    maxTokens: 350,
    temperature: 0.5,
  })

  return {
    text: result.text.trim(),
    model: result.model,
    proteinLeftG: day.proteinLeftG,
    usage: result.usage,
    attestation: result.attestation,
  }
}
