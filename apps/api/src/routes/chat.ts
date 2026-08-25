/**
 * Life chat routes — feature 02, rule R6.
 *
 * The user says anything; we listen, extract, and remember. Extraction is
 * silent: no "I logged 3 items" confirmations. The fastest way to make someone
 * stop telling you things is to make talking feel like filing a form.
 */

import { quoteUntrusted } from '@ogt/core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type OpenAI from 'openai'
import { complete } from '@ogt/og'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import { chatMessages, inferenceUsage, lifeFacts } from '../db/schema.ts'
import { extractFacts, resolveOccurredAt } from '../pipeline/life-chat.ts'
import { blockedResponse, guard } from '../services/safety-gate.ts'
import { buildCoachSystemPrompt, loadCoachContext } from '../services/coach.ts'

const SendBody = z.object({
  message: z.string().min(1).max(4000),
})

export interface ChatRouteDeps {
  db: Database
  openai: OpenAI
}

export async function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): Promise<void> {
  app.post('/chat', async (request, reply) => {
    const userId = currentUserId(request)
    const body = SendBody.parse(request.body)

    // The gate runs first. Always. Before extraction, before the coach, before
    // anything reaches a model.
    const gate = await guard({
      db: deps.db,
      userId: userId,
      text: body.message,
      surface: 'chat',
    })

    // Persist the user's message either way — if someone discloses something
    // serious, deleting it because we declined to coach on it would be worse.
    const [userMessage] = await deps.db
      .insert(chatMessages)
      .values({ userId: userId, role: 'user', content: body.message })
      .returning({ id: chatMessages.id })

    if (gate.blocked) {
      const blocked = blockedResponse(gate.verdict)
      await deps.db.insert(chatMessages).values({
        userId: userId,
        role: 'assistant',
        content: blocked.message,
      })
      return reply.status(200).send(blocked)
    }

    // Extraction and the reply are independent; run them together rather than
    // making the person wait for bookkeeping.
    const context = await loadCoachContext(deps.db, userId)

    const [extraction, coachReply] = await Promise.all([
      extractFacts({ client: deps.openai, message: body.message }),
      complete(deps.openai, {
        task: 'coach',
        messages: [
          { role: 'system', content: buildCoachSystemPrompt(context, gate.verdict) },
          /*
           * A proactive nudge is an assistant turn that is mostly a quote of
           * something the user typed — "Still going on: ...?" — so replaying it
           * unchanged launders their words into assistant authority, which a
           * model weighs more heavily than its own user turns.
           *
           * Fenced on the way back in. Everything we actually wrote is replayed
           * as-is.
           */
          ...context.recentTurns.map((turn) => ({
            role: turn.role as 'user' | 'assistant',
            content: turn.proactive ? quoteUntrusted(turn.content) : turn.content,
          })),
          { role: 'user', content: body.message },
        ],
        maxTokens: 500,
        temperature: 0.4,
      }),
    ])

    const now = new Date()
    if (extraction.extraction.facts.length > 0) {
      await deps.db.insert(lifeFacts).values(
        extraction.extraction.facts.map((fact) => ({
          userId: userId,
          ...(userMessage ? { sourceMessageId: userMessage.id } : {}),
          kind: fact.kind,
          value: fact.value === null ? null : fact.value.toFixed(2),
          unit: fact.unit,
          verbatim: fact.verbatim,
          occurredAt: resolveOccurredAt(fact.occurredOffsetHours, now),
        })),
      )
    }

    await deps.db.insert(chatMessages).values({
      userId: userId,
      role: 'assistant',
      content: coachReply.text,
      model: coachReply.model,
    })

    await deps.db.insert(inferenceUsage).values([
      {
        userId: userId,
        task: 'extraction',
        model: extraction.model,
        promptTokens: extraction.usage.promptTokens,
        completionTokens: extraction.usage.completionTokens,
        usd: extraction.usage.usdEstimate.toFixed(8),
      costNeuron: extraction.usage.costNeuron?.toString() ?? null,
        failovers: extraction.failovers,
        attestation: extraction.attestation.status,
        attestationProvider: extraction.attestation.provider,
        attestationRequestId: extraction.attestation.requestId,
      },
      {
        userId: userId,
        task: 'coach',
        model: coachReply.model,
        promptTokens: coachReply.usage.promptTokens,
        completionTokens: coachReply.usage.completionTokens,
        usd: coachReply.usage.usdEstimate.toFixed(8),
      costNeuron: coachReply.usage.costNeuron?.toString() ?? null,
        failovers: coachReply.failovers,
        attestation: coachReply.attestation.status,
        attestationProvider: coachReply.attestation.provider,
        attestationRequestId: coachReply.attestation.requestId,
      },
    ])

    return reply.status(200).send({
      reply: coachReply.text,
      // Surfaced so the client can show what was understood, tappable to
      // correct. Shown quietly — never as a confirmation dialog.
      understood: extraction.extraction.facts.map((fact) => ({
        kind: fact.kind,
        verbatim: fact.verbatim,
        value: fact.value,
        unit: fact.unit,
      })),
      mentionsFood: extraction.extraction.mentionsFood,
      ...(gate.verdict.level === 'caution' && gate.verdict.message
        ? { notice: gate.verdict.message }
        : {}),
    })
  })

  app.get('/chat/history', async (request, reply) => {
    const userId = currentUserId(request)
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query)
    const context = await loadCoachContext(deps.db, userId, query.limit)
    return reply.status(200).send({ messages: context.recentTurns })
  })
}
