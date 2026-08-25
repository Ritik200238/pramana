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

    /*
     * The reply is the point. Extraction is bookkeeping.
     *
     * These used to run under `Promise.all`, so a failed extraction rejected
     * the whole request and somebody who had just typed something difficult got
     * an error instead of an answer. The two are not equally important, and
     * pretending they are meant the less important one could take the other
     * down.
     *
     * R6 is unaffected either way: their own words were written to
     * `chat_messages` before any of this ran, so nothing they said is lost when
     * extraction fails — only the structured facts we would have derived, which
     * the next message can pick up.
     */
    const [extractionResult, coachReply] = await Promise.all([
      (async () => {
        try {
          return await extractFacts({ client: deps.openai, message: body.message })
        } catch (error) {
          request.log.warn({ err: error }, 'fact extraction failed; the reply still goes out')
          return null
        }
      })(),
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
    const extraction = extractionResult

    if (extraction && extraction.extraction.facts.length > 0) {
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

    /*
     * One row per call that actually happened.
     *
     * An extraction that failed gets no row rather than a row with zeroes and a
     * model named "unavailable": this table is the cost ledger and the
     * attestation record, and a phantom entry would misstate both. The warning
     * above is where a failed extraction is visible.
     */
    await deps.db.insert(inferenceUsage).values([
      ...(extraction
        ? [
            {
              userId: userId,
              task: 'extraction' as const,
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
          ]
        : []),
      {
        userId: userId,
        task: 'coach' as const,
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
      // Empty when extraction failed, which reads to the client exactly as
      // "nothing was understood from this message" — true, and not a reason to
      // withhold the reply.
      understood: (extraction?.extraction.facts ?? []).map((fact) => ({
        kind: fact.kind,
        verbatim: fact.verbatim,
        value: fact.value,
        unit: fact.unit,
      })),
      mentionsFood: extraction?.extraction.mentionsFood ?? false,
      /*
       * Said out loud when the reply was cut short.
       *
       * The model stops at its token limit mid-sentence, and without this the
       * fragment is presented as a finished answer — and stored as one, so it
       * comes back as context later. A coach that appears to trail off is worse
       * than one that says it ran long, because the person cannot tell which
       * happened.
       *
       * The safety notice wins if both apply: being told to talk to somebody
       * matters more than being told the sentence was clipped.
       */
      ...(gate.verdict.level === 'caution' && gate.verdict.message
        ? { notice: gate.verdict.message }
        : coachReply.truncated
          ? { notice: 'That answer ran longer than I had room for — ask again for the rest.' }
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
