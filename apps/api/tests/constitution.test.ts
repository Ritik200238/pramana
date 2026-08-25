/**
 * The constitution, checked against the code that is supposed to obey it.
 *
 * FEATURES.md opens with six rules and says plainly: "When a feature conflicts
 * with a rule, the rule wins." That makes them the most important claims in the
 * repository, and until now four of the six were referenced by a test and two —
 * including R1, which is the entire thesis and the tagline — were not.
 *
 * A rule nothing tests is a sentence in a document. This file does two things
 * about that. It reads the rules out of FEATURES.md rather than restating them,
 * so a seventh rule fails the suite until something proves it. And it covers the
 * two that had no test at all.
 *
 * The mirror-drift lesson applies here more than anywhere: a hand-copied list of
 * rules would go stale exactly when somebody changed the rules.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { classify, planQuestions } from '@ogt/core'
import { startHarness, signIn, VALID_PROFILE } from './helpers/e2e.ts'
import * as schema from './../src/db/schema.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** The rule numbers and titles, read from the document that defines them. */
function constitution(): Array<{ id: string; title: string }> {
  const features = readFileSync(join(ROOT, 'FEATURES.md'), 'utf8')
  const section = features.slice(
    features.indexOf('## TIER 0'),
    features.indexOf('## TIER 1'),
  )

  return Array.from(section.matchAll(/^### (R\d+) — (.+)$/gm)).map((match) => ({
    id: match[1]!,
    title: match[2]!.trim(),
  }))
}

/** Every test file in the repository, wherever it lives. */
function allTestSources(): string {
  const roots = [
    join(ROOT, 'apps', 'api', 'tests'),
    join(ROOT, 'apps', 'web', 'tests'),
    join(ROOT, 'packages', 'core', 'tests'),
    join(ROOT, 'packages', 'og', 'tests'),
  ]

  let combined = ''
  for (const dir of roots) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        combined += readFileSync(join(dir, entry.name), 'utf8')
      }
    }
  }
  return combined
}

test('every rule in the constitution is named by a test that proves it', () => {
  const rules = constitution()

  // If this ever reads zero, the parse broke and the whole check would pass
  // vacuously — which is precisely how an inert guard gets shipped.
  assert.ok(rules.length >= 6, `expected the constitution to have rules, found ${rules.length}`)

  const sources = allTestSources()
  const uncovered = rules.filter((rule) => !new RegExp(`\\b${rule.id}\\b`).test(sources))

  assert.deepEqual(
    uncovered.map((rule) => `${rule.id} — ${rule.title}`),
    [],
    'these rules govern every feature and nothing proves them',
  )
})

test('R1 — an amount we were not told is never presented as one we were', () => {
  /*
   * The thesis, and the tagline: it asks, it doesn't guess.
   *
   * "Never guess" cannot mean "never estimate" — R2 forbids asking about
   * anything that moves the number less than 10%, so small unknowns are
   * estimated by design. What it means operationally is that an estimate is
   * never dressed up as a fact. A number the person confirmed and a number we
   * invented must not look the same.
   */
  const significant = {
    itemId: 'item-1',
    itemName: 'dal',
    kind: 'portion' as const,
    options: ['1 katori', '2 katori'],
    confidence: 0.9,
    kcalSwing: 200,
    proteinSwingG: 8,
  }

  const plan = planQuestions({
    unknowns: [significant],
    known: new Set<string>(),
    mealKcal: 600,
    mealProteinG: 25,
  })

  // It asks rather than assuming.
  assert.equal(plan.ask.length, 1, 'a portion that swings the meal must be asked about')
  assert.match(plan.ask[0]!.text, /how much dal/i)

  /*
   * And if it goes unanswered the meal reads rough, not confirmed — even with
   * the model highly confident. Model confidence is confidence about what the
   * food is; it says nothing about how much of it was on the plate, which is
   * the distinction the whole product is built on.
   */
  const unanswered = classify({
    fromBarcode: false,
    allSignificantAnswered: false,
    userSettledAnAmount: false,
    minItemConfidence: 0.95,
  })
  assert.equal(unanswered, 'rough', 'an unanswered swing must never read as confirmed')

  // The same meal, once they have told us, is confirmed. The difference between
  // these two lines is the product.
  const answered = classify({
    fromBarcode: false,
    allSignificantAnswered: true,
    userSettledAnAmount: true,
    minItemConfidence: 0.95,
  })
  assert.equal(answered, 'confirmed')
})

test('R6 — what a person says is kept, not just answered', async () => {
  /*
   * "Nothing said to us is ever thrown away."
   *
   * The failure this guards against is a chat that replies well and remembers
   * nothing: warm in the moment, useless by next week, and indistinguishable
   * from a good reply until somebody goes looking for what they said.
   */
  const harness = await startHarness()

  try {
    const { token } = await signIn(harness, '+919876500001')

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: VALID_PROFILE,
    })

    const said = 'Slept badly all week and my knee has been hurting since Tuesday.'

    const response = await harness.app.inject({
      method: 'POST',
      url: '/chat',
      headers: { authorization: `Bearer ${token}` },
      payload: { message: said },
    })

    assert.equal(response.statusCode, 200, response.body)

    // It is in the transcript, verbatim. Paraphrasing somebody's own words back
    // into storage is a quiet way of throwing them away.
    const history = await harness.app.inject({
      method: 'GET',
      url: '/chat/history',
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(history.statusCode, 200)
    assert.ok(
      JSON.stringify(history.json()).includes(said),
      'what they said must be retrievable exactly as they said it',
    )

    // And it survives in the database rather than only in a response body.
    const rows = await harness.db.select().from(schema.chatMessages)
    assert.ok(
      rows.some((row) => JSON.stringify(row).includes(said)),
      'the record must outlive the request that created it',
    )
  } finally {
    await harness.close()
  }
})
