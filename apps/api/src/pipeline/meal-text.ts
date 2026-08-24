/**
 * Text and voice meal logging — feature 07.
 *
 * "2 roti aur rajma" must log correctly, typed or spoken. Photo is the fast
 * path, not the only one: photos fail at restaurants, in bad light, and for
 * anything already eaten. A user who cannot log what they just finished eating
 * simply stops logging.
 *
 * This produces exactly the same shape as the vision pipeline, so everything
 * downstream — the question planner, R4 lookups, confidence, commit — is
 * unchanged. The way you told us should never change what we do with it.
 *
 * The prompt is written for Hinglish because that is how the target user
 * actually types: "2 roti aur thoda rajma", not "two rotis and some rajma".
 */

import type OpenAI from 'openai'
import { complete, stripFences, type Usage } from '@ogt/og'
import type { AttestationReceipt } from '@ogt/og'
import { VisionResultSchema, type VisionResult } from './meal-vision.ts'

const SYSTEM_PROMPT = `You turn a short description of a meal into structured items. The person writes casually and usually in Hinglish — "2 roti aur rajma", "ek katori dal chawal", "mess ka khana, rice aur sambar".

Report every distinct dish separately.

You must NOT commit to a quantity you were not given. If they said "2 roti", the count is 2 and you are confident. If they said "thoda rajma" or just "rajma", give a plausible range and low confidence, and report a portion unknown — someone will confirm it.

Report every attribute you cannot determine, in "unknowns":
- portion: how many units, when they did not say
- cooking_fat: ghee, oil, or dry, and roughly how much — never stated in text, worth 100+ kcal
- protein_source: paneer vs tofu vs soya, curd vs cream, whole dal vs watered dal
- preparation: fried vs steamed vs roasted, dry vs cooked weight

Standard references: 1 roti/chapati ~35g, 1 katori ~150ml, 1 idli ~40g, 1 dosa ~90g, 1 cup cooked rice ~150g, 1 glass ~200ml.

Base nutrition on Indian food composition data, not Western equivalents.

Hindi and English names mean the same dish — "chawal" and "rice", "roti" and "chapati". Use the name they used.

If the text describes no food at all, set notFood true and return no items.`

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

export interface ReadTextOptions {
  client: OpenAI
  text: string
  signal?: AbortSignal
}

export interface ReadTextResult {
  /** Proof of where this ran. Travels with whatever it produced. */
  attestation: AttestationReceipt
  vision: VisionResult
  model: string
  failovers: number
  /** Imported rather than restated: a local copy is a copy that drifts. */
  usage: Usage
}

export async function readMealText(opts: ReadTextOptions): Promise<ReadTextResult> {
  const result = await complete(opts.client, {
    task: 'mealVision',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: opts.text },
    ],
    jsonSchema: JSON_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    maxTokens: 1200,
    temperature: 0.1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  return {
    vision: VisionResultSchema.parse(JSON.parse(stripFences(result.text))),
    model: result.model,
    failovers: result.failovers,
    usage: result.usage,
    attestation: result.attestation,
  }
}
