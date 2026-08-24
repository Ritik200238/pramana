/**
 * The safety gate, as a service.
 *
 * @ogt/core decides; this records and enforces. The separation matters: the
 * decision must stay pure and testable, while the enforcement needs a database
 * and a request context.
 *
 * Enforcement rule, and it has no exceptions: **every inbound user message
 * passes through `guard()` before any model call.** Not most routes. Not the
 * chat route. Every one. A single fast path that skips it is the whole gate.
 */

import { screenMessage, screenProfile, type SafetyVerdict, type UserProfile } from '@ogt/core'
import type { Database } from '../db/index.ts'
import { safetyEvents } from '../db/schema.ts'

export type Surface = 'chat' | 'meal_note' | 'onboarding' | 'profile_edit' | 'voice'

export interface GuardInput {
  db: Database
  userId: string | null
  text: string
  surface: Surface
}

export interface GuardResult {
  verdict: SafetyVerdict
  /** True when the caller must stop and return the message without a model call. */
  blocked: boolean
}

/**
 * Screen a message and record the outcome.
 *
 * Only reason codes are persisted. We need to know how often the gate fires and
 * on what class of input; we must not keep what a distressed person typed.
 */
export async function guard(input: GuardInput): Promise<GuardResult> {
  const verdict = screenMessage(input.text)

  if (verdict.level !== 'none') {
    await input.db.insert(safetyEvents).values({
      userId: input.userId,
      level: verdict.level,
      reasons: verdict.reasons,
      surface: input.surface,
    })
  }

  return { verdict, blocked: verdict.level === 'block' }
}

/** Screen a profile at onboarding or on edit, recording the outcome the same way. */
export async function guardProfile(
  db: Database,
  userId: string | null,
  profile: UserProfile,
  surface: Surface,
): Promise<GuardResult> {
  const verdict = screenProfile(profile)

  if (verdict.level !== 'none') {
    await db.insert(safetyEvents).values({
      userId,
      level: verdict.level,
      reasons: verdict.reasons,
      surface,
    })
  }

  return { verdict, blocked: verdict.level === 'block' }
}

/**
 * The shape returned to the client when the gate blocks.
 *
 * HTTP 200, deliberately. A person disclosing something serious is not an
 * error condition, and rendering an error state at that moment would be a
 * cruel piece of interface design.
 */
export interface BlockedResponse {
  blocked: true
  message: string
  /** Where to route them. The client renders this prominently, not as a footnote. */
  helpline?: { label: string; number: string }
}

export function blockedResponse(verdict: SafetyVerdict): BlockedResponse {
  const needsHelpline = verdict.reasons.some(
    (reason) => reason === 'self_harm' || reason.startsWith('ed_'),
  )

  return {
    blocked: true,
    message: verdict.message ?? 'I cannot help with that.',
    ...(needsHelpline
      ? { helpline: { label: 'Tele-MANAS (India), free, 24x7', number: '14416' } }
      : {}),
  }
}
