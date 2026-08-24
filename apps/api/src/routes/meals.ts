/**
 * Meal routes.
 *
 * Two-step by design: `draft` reads the photo and returns questions, `commit`
 * takes the answers and writes the meal. The split is the product — a one-shot
 * endpoint that returned a number would be the guessing behaviour this whole
 * system exists to avoid.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import { readMeal } from '../pipeline/meal-vision.ts'
import { readMealText } from '../pipeline/meal-text.ts'
import { transcribeAudio } from '@ogt/og'
import { VisionResultSchema } from '../pipeline/meal-vision.ts'
import {
  applyAnswers,
  buildDraft,
  commitMealAndStreak,
  loadKnownAttributes,
  type AnswerInput,
  type MealDraft,
} from '../services/meal-log.ts'
import { blockedResponse, guard } from '../services/safety-gate.ts'
import { inferenceUsage } from '../db/schema.ts'

const DraftBody = z.object({
  /** data: URI or https URL. */
  imageUrl: z.string().min(1),
  note: z.string().max(500).optional(),
})

const TextDraftBody = z.object({
  text: z.string().min(1).max(500),
})

const AnswerSchema = z.object({
  itemId: z.string(),
  kind: z.enum(['portion', 'cooking_fat', 'protein_source', 'preparation']),
  answer: z.string(),
  units: z.number().positive().optional(),
  cookingFat: z.enum(['none', 'oil', 'ghee', 'butter']).optional(),
  cookingFatTsp: z.number().nonnegative().optional(),
})

const CommitBody = z.object({
  /** The draft returned by /draft, echoed back. */
  vision: VisionResultSchema,
  answers: z.array(AnswerSchema).max(8),
  mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
  eatenAt: z.coerce.date().optional(),
  source: z.enum(['photo', 'text', 'voice', 'repeat']).default('photo'),
  model: z.string().optional(),
  failovers: z.number().int().nonnegative().default(0),
})

export interface MealRouteDeps {
  db: Database
  openai: OpenAI
  /**
   * Passed separately from the SDK client because the audio endpoint needs a
   * query parameter the SDK cannot add.
   */
  routerApiKey: string
}

export async function registerMealRoutes(app: FastifyInstance, deps: MealRouteDeps): Promise<void> {
  /**
   * Read a photo and return the questions worth asking.
   * Returns a draft; nothing is written until /commit.
   */
  app.post('/meals/draft', async (request, reply) => {
    const userId = currentUserId(request)
    const body = DraftBody.parse(request.body)

    // The note is user text, so it passes the gate before any model sees it.
    if (body.note) {
      const gate = await guard({
        db: deps.db,
        userId: userId,
        text: body.note,
        surface: 'meal_note',
      })
      if (gate.blocked) return reply.status(200).send(blockedResponse(gate.verdict))
    }

    const read = await readMeal({
      client: deps.openai,
      imageUrl: body.imageUrl,
      ...(body.note ? { note: body.note } : {}),
    })

    await deps.db.insert(inferenceUsage).values({
      userId: userId,
      task: 'mealVision',
      model: read.model,
      promptTokens: read.usage.promptTokens,
      completionTokens: read.usage.completionTokens,
      usd: read.usage.usdEstimate.toFixed(8),
      costNeuron: read.usage.costNeuron?.toString() ?? null,
      failovers: read.failovers,
      attestation: read.attestation.status,
      attestationProvider: read.attestation.provider,
      attestationRequestId: read.attestation.requestId,
    })

    if (read.vision.notFood) {
      return reply.status(200).send({
        notFood: true,
        message: "I can't see food in that photo. Try again, or tell me what you ate.",
      })
    }

    const known = await loadKnownAttributes(deps.db, userId)
    const draft = buildDraft(read.vision, known)

    return reply.status(200).send({
      vision: read.vision,
      items: draft.items,
      questions: draft.plan.ask.map((question) => ({
        itemId: question.unknown.itemId,
        itemName: question.unknown.itemName,
        kind: question.unknown.kind,
        text: question.text,
        options: question.unknown.options,
      })),
      unresolvedCount: draft.plan.unresolved.length,
      skippedKnown: draft.skippedKnown,
      estimate: draft.totals,
      model: read.model,
      failovers: read.failovers,
    })
  })

  /**
   * The same flow, from text instead of a photo.
   *
   * "2 roti aur rajma" produces exactly the same draft shape, so the planner,
   * R4 lookups, confidence and commit are all unchanged. Photos fail at
   * restaurants, in bad light, and for anything already eaten — a user who
   * cannot log what they just finished simply stops logging.
   */
  app.post('/meals/draft-text', async (request, reply) => {
    const userId = currentUserId(request)
    const body = TextDraftBody.parse(request.body)

    const gate = await guard({
      db: deps.db,
      userId: userId,
      text: body.text,
      surface: 'meal_note',
    })
    if (gate.blocked) return reply.status(200).send(blockedResponse(gate.verdict))

    const read = await readMealText({ client: deps.openai, text: body.text })

    await deps.db.insert(inferenceUsage).values({
      userId: userId,
      task: 'mealVision',
      model: read.model,
      promptTokens: read.usage.promptTokens,
      completionTokens: read.usage.completionTokens,
      usd: read.usage.usdEstimate.toFixed(8),
      costNeuron: read.usage.costNeuron?.toString() ?? null,
      failovers: read.failovers,
      attestation: read.attestation.status,
      attestationProvider: read.attestation.provider,
      attestationRequestId: read.attestation.requestId,
    })

    if (read.vision.notFood) {
      return reply.status(200).send({
        notFood: true,
        message: "I couldn't find any food in that. Try naming the dishes.",
      })
    }

    const known = await loadKnownAttributes(deps.db, userId)
    const draft = buildDraft(read.vision, known)

    return reply.status(200).send({
      vision: read.vision,
      items: draft.items,
      questions: draft.plan.ask.map((question) => ({
        itemId: question.unknown.itemId,
        itemName: question.unknown.itemName,
        kind: question.unknown.kind,
        text: question.text,
        options: question.unknown.options,
      })),
      unresolvedCount: draft.plan.unresolved.length,
      skippedKnown: draft.skippedKnown,
      estimate: draft.totals,
      model: read.model,
      failovers: read.failovers,
    })
  })

  /**
   * Voice, via whisper-large-v3 on 0G Compute.
   *
   * Transcription only — the text then goes through /meals/draft-text like
   * anything else typed. Keeping them separate means a bad transcription is
   * visible and correctable rather than silently logged.
   */
  app.post('/meals/transcribe', async (request, reply) => {
    const userId = currentUserId(request)
    const file = await request.file()
    if (!file) return reply.status(400).send({ error: 'no_audio' })

    const language = (request.query as { language?: string }).language

    try {
      const buffer = await file.toBuffer()
      const audio = new File([buffer], file.filename, { type: file.mimetype })

      // Attested like every other model call. This endpoint sends `verify_tee`
      // as a query parameter rather than a body field, because it is multipart
      // — see packages/og/src/speech.ts.
      const result = await transcribeAudio({
        apiKey: deps.routerApiKey,
        audio,
        ...(language ? { language } : {}),
      })

      // Recorded, so a voice note appears in the receipts the app shows a
      // person. It was the one model call missing from that list, which made
      // the proof screen quietly incomplete for anybody who spoke to the app.
      await deps.db.insert(inferenceUsage).values({
        userId,
        task: 'speech',
        model: result.model,
        promptTokens: 0,
        completionTokens: 0,
        usd: '0',
        failovers: 0,
        attestation: result.attestation.status,
        attestationProvider: result.attestation.provider,
        attestationRequestId: result.attestation.requestId,
      })

      return reply.status(200).send({ text: result.text })
    } catch (error) {
      request.log.error({ err: error }, 'transcription failed')
      // The client falls back to the keyboard rather than to a worse guess.
      return reply.status(502).send({ error: 'transcription_failed' })
    }
  })

  /** Apply answers and write the meal. */
  app.post('/meals/commit', async (request, reply) => {
    const userId = currentUserId(request)
    const body = CommitBody.parse(request.body)

    const known = await loadKnownAttributes(deps.db, userId)
    const base: MealDraft = buildDraft(body.vision, known)
    const answered = applyAnswers(base, body.answers as AnswerInput[])

    const result = await commitMealAndStreak({
      db: deps.db,
      userId: userId,
      draft: answered,
      answers: body.answers as AnswerInput[],
      ...(body.mealType ? { mealType: body.mealType } : {}),
      ...(body.eatenAt ? { eatenAt: body.eatenAt } : {}),
      source: body.source,
      ...(body.model ? { model: body.model } : {}),
      failovers: body.failovers,
    })

    return reply.status(201).send(result)
  })
}
