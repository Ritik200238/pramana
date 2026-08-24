/**
 * Lab report reading — features 16 and 17.
 *
 * The largest gap found in the entire research. Hindi videos explaining ECG,
 * cancer and ultrasound reports draw 2.2M, 1.05M and 903K views; the best
 * AI-native equivalent has 706. Millions of people already do this work by
 * hand, in the worst possible way, and nobody has served them.
 *
 * The boundary here is the whole feature, and it is not negotiable:
 *
 *   **We explain what a marker measures. We never say what it means for them.**
 *
 * "HbA1c is your average blood sugar over about three months" is education.
 * "Your HbA1c means you are pre-diabetic" is diagnosis, which makes this a
 * medical device and makes us liable. Every extracted value therefore carries
 * the lab's own reference range, and every interpretation routes to a doctor.
 *
 * ⚠️ UNVERIFIED: whether these models read Indian lab report layouts
 * accurately. The PRD gates this feature on exactly that test, and it has not
 * been run. Until it has, this is built but should not be trusted.
 */

import { z } from 'zod'
import type OpenAI from 'openai'
import { complete, stripFences } from '@ogt/og'
import type { AttestationReceipt } from '@ogt/og'

const SYSTEM_PROMPT = `You read photographs of medical laboratory reports and extract the measured values. Indian lab formats are your main case: Dr Lal PathLabs, Thyrocare, Metropolis, SRL, Apollo, and hospital in-house labs.

Extract every numeric result you can read clearly.

For each one give:
- code: a normalised lowercase key, so the same test matches across labs. Use: hba1c, fasting_glucose, post_prandial_glucose, total_cholesterol, ldl, hdl, triglycerides, vitamin_d, vitamin_b12, tsh, t3, t4, haemoglobin, ferritin, creatinine, urea, uric_acid, sgpt_alt, sgot_ast, platelets, wbc, rbc. Anything else: a sensible snake_case key.
- name: exactly as printed on the report.
- value, unit: as printed.
- refLow, refHigh: the reference range printed on THAT report. Ranges differ between labs — never substitute a range you remember.
- flag: low, normal, or high, based only on the printed range. If no range is printed, use unknown.

Also extract labName and collectedAt (the sample collection date, in ISO format) when printed.

Write a "summary" that says, in plain language, what each out-of-range marker MEASURES. Two sentences maximum per marker.

You must NOT:
- name a condition or disease
- say what a result means for this person's health
- suggest treatment, medication, or supplements
- say whether something is serious
- reassure them

If the image is not a lab report, set notReport true and extract nothing.
If you cannot read a value with confidence, leave it out. A missing marker is recoverable; a wrong number is not.`

const MarkerSchema = z.object({
  code: z.string(),
  name: z.string(),
  value: z.number(),
  unit: z.string(),
  refLow: z.number().nullable(),
  refHigh: z.number().nullable(),
  flag: z.enum(['low', 'normal', 'high', 'unknown']),
})

export const LabReadingSchema = z.object({
  notReport: z.boolean(),
  labName: z.string().nullable(),
  collectedAt: z.string().nullable(),
  markers: z.array(MarkerSchema),
  summary: z.string(),
})

export type LabReading = z.infer<typeof LabReadingSchema>
export type ExtractedMarker = z.infer<typeof MarkerSchema>

const JSON_SCHEMA = {
  name: 'lab_reading',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['notReport', 'labName', 'collectedAt', 'markers', 'summary'],
    properties: {
      notReport: { type: 'boolean' },
      labName: { type: ['string', 'null'] },
      collectedAt: { type: ['string', 'null'] },
      markers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'value', 'unit', 'refLow', 'refHigh', 'flag'],
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            value: { type: 'number' },
            unit: { type: 'string' },
            refLow: { type: ['number', 'null'] },
            refHigh: { type: ['number', 'null'] },
            flag: { type: 'string', enum: ['low', 'normal', 'high', 'unknown'] },
          },
        },
      },
      summary: { type: 'string' },
    },
  },
} as const

export interface ReadLabReportOptions {
  client: OpenAI
  /** data: URI or https URL of the report page. */
  imageUrl: string
  signal?: AbortSignal
}

export interface ReadLabReportResult {
  /** Proof of where this ran. Travels with whatever it produced. */
  attestation: AttestationReceipt
  reading: LabReading
  model: string
  failovers: number
  usage: { promptTokens: number; completionTokens: number; usd: number }
}

export async function readLabReport(opts: ReadLabReportOptions): Promise<ReadLabReportResult> {
  const result = await complete(opts.client, {
    task: 'mealVision', // the TEE-attested vision chain; nothing meal-specific about it
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: opts.imageUrl } }],
      },
    ],
    jsonSchema: JSON_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    maxTokens: 2000,
    temperature: 0.05, // extraction, not interpretation — as deterministic as we can make it
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const reading = LabReadingSchema.parse(JSON.parse(stripFences(result.text)))

  return {
    reading: { ...reading, summary: sanitiseSummary(reading.summary) },
    model: result.model,
    failovers: result.failovers,
    usage: result.usage,
    attestation: result.attestation,
  }
}

/**
 * Last-resort guard on the summary text.
 *
 * The prompt forbids naming conditions, but a prompt is a request and this is a
 * boundary we are not willing to leave to one. If the model names a condition
 * anyway, we drop the summary rather than show it — a missing explanation is a
 * disappointment; an accidental diagnosis is a regulatory and human problem.
 */
const DIAGNOSTIC_LANGUAGE =
  /\b(diabet\w*|pre.?diabet\w*|hypertens\w*|anaemi\w*|anemi\w*|thyroid(ism)?|hypothyroid\w*|hyperthyroid\w*|deficien\w*|disease|disorder|syndrome|cancer|failure|infection|you (have|are|may have|might have|likely have)|suggests? that you|indicat\w* that you|consistent with)\b/i

export const SAFE_FALLBACK_SUMMARY =
  'Your results are extracted below with the reference range printed on your report. ' +
  'What any of it means for you is a question for a doctor — please take this report to one.'

export function sanitiseSummary(summary: string): string {
  return DIAGNOSTIC_LANGUAGE.test(summary) ? SAFE_FALLBACK_SUMMARY : summary.trim()
}

/**
 * Derive the flag ourselves where a range exists.
 *
 * The model's own flag is a judgement; this is arithmetic. Arithmetic wins.
 */
export function deriveFlag(marker: ExtractedMarker): 'low' | 'normal' | 'high' | 'unknown' {
  if (marker.refLow === null && marker.refHigh === null) return 'unknown'
  if (marker.refLow !== null && marker.value < marker.refLow) return 'low'
  if (marker.refHigh !== null && marker.value > marker.refHigh) return 'high'
  return 'normal'
}
