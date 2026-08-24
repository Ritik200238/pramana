/**
 * Tier 2 routes — suggestions, reviews, questions, streaks, lab reports.
 *
 * Every one of these is "feedback, not charts". The numbers are computed in
 * code and handed to the model already correct; the model's only job is to say
 * them like a person would.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type OpenAI from 'openai'
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import { healthMarkers, households, inferenceUsage, labReports, users } from '../db/schema.ts'
import { getDaySummary } from '../services/day.ts'
import { getStreak } from '../services/streaks.ts'
import { suggestMeal } from '../services/suggest.ts'
import {
  askOwnData,
  computeWeekFacts,
  gatherRecords,
  writeDayLine,
  writeWeekReview,
} from '../services/review.ts'
import { deriveFlag, readLabReport } from '../pipeline/lab-report.ts'
import { blockedResponse, guard } from '../services/safety-gate.ts'

const OffsetQuery = z.object({
  utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(330),
})

export interface CoachRouteDeps {
  db: Database
  openai: OpenAI
}

export async function registerCoachRoutes(
  app: FastifyInstance,
  deps: CoachRouteDeps,
): Promise<void> {
  /** Feature 10 — what to eat next, from what is actually available. */
  app.post('/users/me/suggest', async (request, reply) => {
    const userId = currentUserId(request)
    const body = z
      .object({
        available: z.string().max(600).optional(),
        utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(330),
      })
      .parse(request.body ?? {})

    // Their description of what is available is free text and goes to a model,
    // so it passes the gate first like everything else.
    if (body.available) {
      const gate = await guard({
        db: deps.db,
        userId,
        text: body.available,
        surface: 'chat',
      })
      if (gate.blocked) return reply.status(200).send(blockedResponse(gate.verdict))
    }

    const result = await suggestMeal({
      db: deps.db,
      client: deps.openai,
      userId,
      ...(body.available ? { available: body.available } : {}),
      utcOffsetMinutes: body.utcOffsetMinutes,
    })

    await deps.db.insert(inferenceUsage).values({
      userId,
      task: 'coach',
      model: result.model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      usd: result.usage.usd.toFixed(8),
      attestation: result.attestation.status,
      attestationProvider: result.attestation.provider,
      attestationRequestId: result.attestation.requestId,
    })

    return reply.status(200).send({ suggestion: result.text, proteinLeftG: result.proteinLeftG })
  })

  /** Feature 11 — one line about today, and one thing to change. */
  app.get('/users/me/day-line', async (request, reply) => {
    const userId = currentUserId(request)
    const { utcOffsetMinutes } = OffsetQuery.parse(request.query)

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) return reply.status(404).send({ error: 'not_found' })

    const day = await getDaySummary({ db: deps.db, userId, utcOffsetMinutes })
    const streak = await getStreak(deps.db, userId, new Date(), utcOffsetMinutes)

    const line = await writeDayLine({
      client: deps.openai,
      facts: {
        date: day.date,
        kcal: day.totals.kcal,
        proteinG: day.totals.proteinG,
        mealCount: day.mealCount,
        proteinTargetG: day.targets?.proteinG ?? null,
        proteinHit: day.targets ? day.totals.proteinG >= day.targets.proteinG * 0.9 : false,
        questionsAsked: Math.round(day.questionsPerMeal * day.mealCount),
      },
      streakDays: streak.currentDays,
      tone: user.tone,
    })

    return reply.status(200).send({ line: line.text, streak })
  })

  /** Feature 14 — the week, and one adjustment. */
  app.get('/users/me/weekly', async (request, reply) => {
    const userId = currentUserId(request)
    const { utcOffsetMinutes } = OffsetQuery.parse(request.query)

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) return reply.status(404).send({ error: 'not_found' })

    const facts = await computeWeekFacts(deps.db, userId, new Date(), utcOffsetMinutes)

    // Nothing to review is not an error, and inventing a review from two data
    // points would be worse than saying so.
    if (facts.daysLogged < 2) {
      return reply.status(200).send({
        review: null,
        facts,
        message: 'Not enough logged yet this week for a useful review.',
      })
    }

    const review = await writeWeekReview({ client: deps.openai, facts, tone: user.tone })
    return reply.status(200).send({ review: review.text, facts })
  })

  /** Feature 12 — ask your own data anything. */
  app.post('/users/me/ask', async (request, reply) => {
    const userId = currentUserId(request)
    const body = z
      .object({
        question: z.string().min(1).max(500),
        days: z.coerce.number().int().min(1).max(90).default(14),
        utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(330),
      })
      .parse(request.body)

    const gate = await guard({ db: deps.db, userId, text: body.question, surface: 'chat' })
    if (gate.blocked) return reply.status(200).send(blockedResponse(gate.verdict))

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) return reply.status(404).send({ error: 'not_found' })

    const records = await gatherRecords(
      deps.db,
      userId,
      body.days,
      new Date(),
      body.utcOffsetMinutes,
    )

    const answer = await askOwnData({
      client: deps.openai,
      question: body.question,
      records,
      tone: user.tone,
    })

    return reply.status(200).send({
      answer: answer.text,
      ...(gate.verdict.level === 'caution' && gate.verdict.message
        ? { notice: gate.verdict.message }
        : {}),
    })
  })

  /** Feature 15 — the streak, reported as it stands now rather than when last written. */
  app.get('/users/me/streak', async (request, reply) => {
    const userId = currentUserId(request)
    const { utcOffsetMinutes } = OffsetQuery.parse(request.query)
    const streak = await getStreak(deps.db, userId, new Date(), utcOffsetMinutes)
    return reply.status(200).send(streak)
  })

  /** Feature 16 — read a lab report. Explains what markers measure; never diagnoses. */
  app.post('/users/me/reports', async (request, reply) => {
    const userId = currentUserId(request)
    const body = z.object({ imageUrl: z.string().min(1) }).parse(request.body)

    const [report] = await deps.db
      .insert(labReports)
      .values({ userId, status: 'pending' })
      .returning({ id: labReports.id })

    if (!report) return reply.status(500).send({ error: 'internal_error' })

    try {
      const read = await readLabReport({ client: deps.openai, imageUrl: body.imageUrl })

      await deps.db.insert(inferenceUsage).values({
        userId,
        task: 'mealVision',
        model: read.model,
        promptTokens: read.usage.promptTokens,
        completionTokens: read.usage.completionTokens,
        usd: read.usage.usd.toFixed(8),
        failovers: read.failovers,
        attestation: read.attestation.status,
        attestationProvider: read.attestation.provider,
        attestationRequestId: read.attestation.requestId,
      })

      if (read.reading.notReport || read.reading.markers.length === 0) {
        await deps.db
          .update(labReports)
          .set({ status: 'failed', failureReason: 'no_markers_found' })
          .where(eq(labReports.id, report.id))

        return reply.status(200).send({
          reportId: report.id,
          status: 'failed',
          message:
            "I couldn't read any results from that. A clearer photo of the results page usually works.",
        })
      }

      const collectedAt = parseDate(read.reading.collectedAt)

      await deps.db.insert(healthMarkers).values(
        read.reading.markers.map((marker) => ({
          userId,
          reportId: report.id,
          code: marker.code,
          name: marker.name,
          value: marker.value.toFixed(3),
          unit: marker.unit,
          refLow: marker.refLow === null ? null : marker.refLow.toFixed(3),
          refHigh: marker.refHigh === null ? null : marker.refHigh.toFixed(3),
          // Arithmetic beats the model's judgement wherever a range exists.
          flag: deriveFlag(marker),
          measuredAt: collectedAt ?? new Date(),
        })),
      )

      await deps.db
        .update(labReports)
        .set({
          status: 'ready',
          labName: read.reading.labName,
          ...(collectedAt ? { collectedAt } : {}),
          model: read.model,
          summary: read.reading.summary,
        })
        .where(eq(labReports.id, report.id))

      return reply.status(201).send({
        reportId: report.id,
        status: 'ready',
        labName: read.reading.labName,
        collectedAt,
        summary: read.reading.summary,
        markers: read.reading.markers.map((marker) => ({
          ...marker,
          flag: deriveFlag(marker),
        })),
        disclaimer:
          'This explains what each measurement is. What your results mean is a question for a doctor.',
      })
    } catch (error) {
      request.log.error({ err: error }, 'lab report reading failed')
      await deps.db
        .update(labReports)
        .set({ status: 'failed', failureReason: 'extraction_error' })
        .where(eq(labReports.id, report.id))
      return reply.status(502).send({ error: 'report_read_failed' })
    }
  })

  /** Feature 17 — one marker over time. */
  app.get('/users/me/markers', async (request, reply) => {
    const userId = currentUserId(request)
    const { code } = z.object({ code: z.string().optional() }).parse(request.query)

    const rows = await deps.db
      .select()
      .from(healthMarkers)
      .where(
        code
          ? and(eq(healthMarkers.userId, userId), eq(healthMarkers.code, code))
          : eq(healthMarkers.userId, userId),
      )
      .orderBy(desc(healthMarkers.measuredAt))
      .limit(200)

    // Group into series so a marker reads as a trend rather than a list.
    const series = new Map<string, { code: string; name: string; unit: string; points: unknown[] }>()
    for (const row of rows) {
      const entry = series.get(row.code) ?? {
        code: row.code,
        name: row.name,
        unit: row.unit,
        points: [],
      }
      entry.points.push({
        value: Number(row.value),
        flag: row.flag,
        refLow: row.refLow === null ? null : Number(row.refLow),
        refHigh: row.refHigh === null ? null : Number(row.refHigh),
        measuredAt: row.measuredAt,
      })
      series.set(row.code, entry)
    }

    return reply.status(200).send({ series: [...series.values()] })
  })

  /**
   * The privacy receipt.
   *
   * The point of the whole TEE binding: a user can look at what actually
   * happened to their data rather than take our word for it. Every inference
   * about their body, which enclave provider ran it, and whether the hardware
   * signature verified.
   *
   * No hosted API can produce this. That is precisely why it is here.
   */
  app.get('/users/me/proof', async (request, reply) => {
    const userId = currentUserId(request)
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query)

    const rows = await deps.db
      .select({
        task: inferenceUsage.task,
        model: inferenceUsage.model,
        attestation: inferenceUsage.attestation,
        provider: inferenceUsage.attestationProvider,
        requestId: inferenceUsage.attestationRequestId,
        createdAt: inferenceUsage.createdAt,
      })
      .from(inferenceUsage)
      .where(eq(inferenceUsage.userId, userId))
      .orderBy(desc(inferenceUsage.createdAt))
      .limit(limit)

    const verified = rows.filter((row) => row.attestation === 'verified').length

    return reply.status(200).send({
      total: rows.length,
      verified,
      // Stated plainly rather than rounded up. A receipt that overclaims is
      // worse than no receipt.
      summary:
        rows.length === 0
          ? 'Nothing computed yet.'
          : verified === rows.length
            ? `All ${rows.length} computations ran on providers 0G verified as running inside sealed hardware. That verification is 0G's own check, reported here — not a signature you can re-run yourself.`
            : `${verified} of ${rows.length} computations were verified as running inside a sealed enclave.`,
      receipts: rows.map((row) => ({
        ...row,
        explorer: row.provider ? `https://chainscan-galileo.0g.ai/address/${row.provider}` : null,
      })),
    })
  })

  /** The kitchen. Feeds feature 10 so suggestions use what they actually have. */
  app.put('/users/me/pantry', async (request, reply) => {
    const userId = currentUserId(request)
    const { items } = z
      .object({ items: z.array(z.string().min(1).max(60)).max(80) })
      .parse(request.body)

    // Pantry items are free text and end up in the suggestion prompt, so they
    // pass the gate like any other user input. Anything reaching a model does.
    const gate = await guard({
      db: deps.db,
      userId,
      text: items.join(', '),
      surface: 'chat',
    })
    if (gate.blocked) return reply.status(200).send(blockedResponse(gate.verdict))

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user?.householdId) return reply.status(409).send({ error: 'no_household' })

    await deps.db.update(households).set({ pantry: items }).where(eq(households.id, user.householdId))

    return reply.status(200).send({ items })
  })
}

function parseDate(value: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  // A collection date in the future, or before the era of the tests we support,
  // is an extraction error rather than a real date.
  const now = Date.now()
  if (parsed.getTime() > now + 86_400_000) return null
  if (parsed.getTime() < Date.parse('1990-01-01')) return null
  return parsed
}
