/**
 * Meal photo -> items -> questions.
 *
 * This is R1 in executable form: the model is forbidden from committing to a quantity.
 * It returns what it sees, a plausible range, and its own confidence. The
 * deterministic planner in @ogt/core then decides what is worth asking.
 *
 * The prompt is written around the documented failure modes of vision models on
 * Indian food, not around generic food recognition:
 *
 *   - Models identify reliably and estimate quantity terribly (21-54% error
 *     across five frontier models against a kitchen scale).
 *   - A thali is many items, not one dish.
 *   - Cooking fat is invisible in a photograph and worth 100+ kcal.
 *   - Dry vs cooked weight mismatches triple a number silently.
 */

import { z } from 'zod'
import type OpenAI from 'openai'
import { complete, stripFences } from '@ogt/og'
import type { AttestationReceipt } from '@ogt/og'
import type { Unknown, UnknownKind } from '@ogt/core'

const SYSTEM_PROMPT = `You read photographs of food and report what is on the plate. You know Indian home, mess, tiffin and restaurant food well.

Report every distinct item separately. A thali or a plate usually holds several — count them individually, never as one dish.

You must NOT commit to a quantity. For each item give a plausible range in the household unit a person would actually use — roti, katori, glass, plate, piece — and say how confident you are. Someone will confirm the amount; guessing it wrongly is worse than admitting you cannot tell.

Report every attribute you cannot determine from the image, in "unknowns". The ones that matter most:
- portion: how many units are on the plate
- cooking_fat: whether it was cooked in ghee, oil, or dry, and roughly how much — invisible in a photo, worth 100+ kcal
- protein_source: paneer vs tofu vs soya, curd vs cream, whole dal vs watered dal — small calorie difference, large protein difference
- preparation: fried vs steamed vs roasted, dry vs cooked weight

Standard references: 1 roti/chapati ~35g, 1 katori ~150ml, 1 idli ~40g, 1 dosa ~90g, 1 cup cooked rice ~150g, 1 glass ~200ml.

Base nutrition on Indian food composition data where you can, not on Western equivalents. Indian preparations differ in oil, portion and method.

Set confidence honestly per item and per attribute. Below 0.6 means you are guessing. Prefer a low score over a confident wrong number.

If the image contains no food, set notFood true and return no items.`

const VisionItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string(),
  unitsLow: z.number().nonnegative(),
  unitsHigh: z.number().nonnegative(),
  gramsPerUnit: z.number().nonnegative(),
  kcalPer100g: z.number().nonnegative(),
  proteinPer100g: z.number().nonnegative(),
  carbPer100g: z.number().nonnegative(),
  fatPer100g: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
})

const VisionUnknownSchema = z.object({
  itemId: z.string(),
  kind: z.enum(['portion', 'cooking_fat', 'protein_source', 'preparation']),
  options: z.array(z.string()).min(2),
  kcalSwing: z.number().nonnegative(),
  proteinSwingG: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
})

export const VisionResultSchema = z.object({
  items: z.array(VisionItemSchema),
  unknowns: z.array(VisionUnknownSchema),
  notFood: z.boolean(),
})

export type VisionItem = z.infer<typeof VisionItemSchema>
export type VisionResult = z.infer<typeof VisionResultSchema>

const JSON_SCHEMA = {
  name: 'meal_reading',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'unknowns', 'notFood'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'name',
            'unit',
            'unitsLow',
            'unitsHigh',
            'gramsPerUnit',
            'kcalPer100g',
            'proteinPer100g',
            'carbPer100g',
            'fatPer100g',
            'confidence',
          ],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            unit: { type: 'string' },
            unitsLow: { type: 'number' },
            unitsHigh: { type: 'number' },
            gramsPerUnit: { type: 'number' },
            kcalPer100g: { type: 'number' },
            proteinPer100g: { type: 'number' },
            carbPer100g: { type: 'number' },
            fatPer100g: { type: 'number' },
            confidence: { type: 'number' },
          },
        },
      },
      unknowns: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['itemId', 'kind', 'options', 'kcalSwing', 'proteinSwingG', 'confidence'],
          properties: {
            itemId: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['portion', 'cooking_fat', 'protein_source', 'preparation'],
            },
            options: { type: 'array', items: { type: 'string' } },
            kcalSwing: { type: 'number' },
            proteinSwingG: { type: 'number' },
            confidence: { type: 'number' },
          },
        },
      },
      notFood: { type: 'boolean' },
    },
  },
} as const

export interface ReadMealOptions {
  client: OpenAI
  /** data: URI or https URL. */
  imageUrl: string
  /** Free-text hint, e.g. "ghar ka khana, no oil". */
  note?: string
  signal?: AbortSignal
}

export interface ReadMealResult {
  /** Proof of where this ran. Travels with whatever it produced. */
  attestation: AttestationReceipt
  vision: VisionResult
  model: string
  failovers: number
  usage: { promptTokens: number; completionTokens: number; usd: number }
}

export async function readMeal(opts: ReadMealOptions): Promise<ReadMealResult> {
  const content: OpenAI.ChatCompletionContentPart[] = [
    { type: 'image_url', image_url: { url: opts.imageUrl } },
  ]
  if (opts.note) {
    content.push({ type: 'text', text: `The person adds: ${opts.note}` })
  }

  const result = await complete(opts.client, {
    task: 'mealVision',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    jsonSchema: JSON_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    maxTokens: 1500,
    temperature: 0.1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const vision = VisionResultSchema.parse(JSON.parse(stripFences(result.text)))

  return {
    vision,
    model: result.model,
    failovers: result.failovers,
    usage: result.usage,
    attestation: result.attestation,
  }
}

/**
 * Midpoint estimate for an item, used only to size the meal so the planner can
 * compute impact shares. It is never shown as a final number — the whole point
 * is that the user confirms the quantity.
 */
export function midpointEstimate(item: VisionItem): {
  units: number
  grams: number
  kcal: number
  proteinG: number
  carbG: number
  fatG: number
} {
  const units = (item.unitsLow + item.unitsHigh) / 2
  const grams = units * item.gramsPerUnit
  const per = grams / 100
  return {
    units,
    grams,
    kcal: item.kcalPer100g * per,
    proteinG: item.proteinPer100g * per,
    carbG: item.carbPer100g * per,
    fatG: item.fatPer100g * per,
  }
}

/** Bridge the model's shape into the planner's, keyed by item name for R4. */
export function toPlannerUnknowns(vision: VisionResult): Unknown[] {
  const nameById = new Map(vision.items.map((item) => [item.id, item.name]))

  return vision.unknowns.flatMap((unknown) => {
    const itemName = nameById.get(unknown.itemId)
    // An unknown pointing at an item the model did not report is unusable —
    // we cannot ask about a dish that is not on the plate.
    if (itemName === undefined) return []

    return [
      {
        kind: unknown.kind as UnknownKind,
        itemId: unknown.itemId,
        itemName,
        kcalSwing: unknown.kcalSwing,
        proteinSwingG: unknown.proteinSwingG,
        confidence: unknown.confidence,
        options: unknown.options,
      },
    ]
  })
}
