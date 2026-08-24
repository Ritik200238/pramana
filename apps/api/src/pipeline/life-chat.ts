/**
 * Life chat extraction — R6.
 *
 * One always-open conversation where a person says whatever is true. Everything
 * they say becomes structured, timestamped, permanent context.
 *
 * This exists because of the single most damning complaint about every shipped
 * AI health coach: they cannot see their own product's data. Users report being
 * told to "type all this information manually into the prompt", or that the
 * coach "only sees the last 7 days". We have everything, because the user told
 * us once and we kept it.
 *
 * Extraction is silent. No "I've logged 3 items" confirmations — the fastest
 * way to make someone stop talking to you is to make talking feel like filing.
 */

import { z } from 'zod'
import type OpenAI from 'openai'
import { complete, stripFences, type Usage } from '@ogt/og'
import type { AttestationReceipt } from '@ogt/og'

const FACT_KINDS = [
  'sleep',
  'workout',
  'mood',
  'symptom',
  'energy',
  'weight',
  'travel',
  'cycle',
  'medication',
  'other',
] as const

const SYSTEM_PROMPT = `You extract structured facts from what a person tells you about their day. They speak casually, often in Hinglish. They are not filling in a form.

Return every fact you can support from their words, and nothing you cannot.

Kinds:
- sleep      hours slept, quality
- workout    training done, and how it felt
- mood       stress, low, good
- symptom    anything bodily they report
- energy     tiredness or alertness
- weight     a weight they state
- travel     being away, changed routine, upcoming trips
- cycle      menstrual cycle
- medication anything they took
- other      anything real that fits nowhere above

Rules:
- Put a number in "value" only when they gave one or clearly implied one. "slept badly" has no value; "slept 5 hours" has value 5, unit "hours".
- "verbatim" must be their own words for that fact, trimmed. Never your paraphrase. We show this back to them and getting it wrong means telling someone their experience was something other than what they said.
- "occurredOffsetHours" is how long before now the fact refers to. Now is 0. Last night is about -10. Do not invent precision.
- If they mention food, do NOT extract it here. Food is logged separately.
- If they say nothing factual, return an empty list. That is a normal outcome.
- Never diagnose. Never interpret a symptom. Record what they said.`

const LifeFactSchema = z.object({
  kind: z.enum(FACT_KINDS),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  verbatim: z.string().min(1),
  occurredOffsetHours: z.number(),
})

export const ExtractionSchema = z.object({
  facts: z.array(LifeFactSchema),
  /** Foods mentioned in passing, handed to the meal pipeline rather than parsed here. */
  mentionsFood: z.boolean(),
})

export type LifeFactDraft = z.infer<typeof LifeFactSchema>
export type Extraction = z.infer<typeof ExtractionSchema>

const JSON_SCHEMA = {
  name: 'life_extraction',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['facts', 'mentionsFood'],
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'value', 'unit', 'verbatim', 'occurredOffsetHours'],
          properties: {
            kind: { type: 'string', enum: [...FACT_KINDS] },
            value: { type: ['number', 'null'] },
            unit: { type: ['string', 'null'] },
            verbatim: { type: 'string' },
            occurredOffsetHours: { type: 'number' },
          },
        },
      },
      mentionsFood: { type: 'boolean' },
    },
  },
} as const

export interface ExtractOptions {
  client: OpenAI
  message: string
  signal?: AbortSignal
}

export interface ExtractResult {
  /** Proof of where this ran. Travels with whatever it produced. */
  attestation: AttestationReceipt
  extraction: Extraction
  model: string
  failovers: number
  /** Imported rather than restated: a local copy is a copy that drifts. */
  usage: Usage
}

export async function extractFacts(opts: ExtractOptions): Promise<ExtractResult> {
  const result = await complete(opts.client, {
    task: 'extraction',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: opts.message },
    ],
    jsonSchema: JSON_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    maxTokens: 900,
    temperature: 0.1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const extraction = ExtractionSchema.parse(JSON.parse(stripFences(result.text)))

  return {
    extraction,
    model: result.model,
    failovers: result.failovers,
    usage: result.usage,
    attestation: result.attestation,
  }
}

/**
 * Resolve a fact's absolute timestamp.
 *
 * Clamped to a fortnight in each direction. People misremember, and models
 * hallucinate offsets; a "symptom" dated three years out would quietly poison
 * every trend the coach later reports.
 */
const MAX_OFFSET_HOURS = 24 * 14

export function resolveOccurredAt(offsetHours: number, now: Date): Date {
  const clamped = Math.max(-MAX_OFFSET_HOURS, Math.min(MAX_OFFSET_HOURS, offsetHours))
  return new Date(now.getTime() + clamped * 60 * 60 * 1000)
}
