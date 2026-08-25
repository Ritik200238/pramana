/**
 * @vitest-environment jsdom
 *
 * Every screen, checked by axe rather than by eye.
 *
 * The individual screen tests already assert the things somebody thought to
 * assert — a label here, an aria-live there. That is exactly the weakness: it
 * finds what was remembered. axe applies the WCAG rules systematically, which
 * is how a missing form label or an unreadable control gets caught by something
 * other than the person who wrote it.
 *
 * This is a health app. The people most likely to be using a screen reader, a
 * larger font, or voice control are disproportionately the people with a
 * long-term condition to track — which is to say, the people this is for.
 *
 * Scoped to the rules that a component rendered in isolation can honestly be
 * judged on. Landmark and page-level rules need a whole document and would fail
 * here for reasons that say nothing about the product.
 */

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { api } from '../src/lib/api.ts'
import { SignIn } from '../src/screens/SignIn.tsx'
import { Onboarding } from '../src/screens/Onboarding.tsx'
import { Today } from '../src/screens/Today.tsx'
import { Chat } from '../src/screens/Chat.tsx'
import { Coach } from '../src/screens/Coach.tsx'
import { MealFlow } from '../src/screens/MealFlow.tsx'
import { LabReport } from '../src/components/LabReport.tsx'
import { Remembered } from '../src/components/Remembered.tsx'
import { Custody } from '../src/components/Custody.tsx'

beforeAll(() => {
  // jsdom has no layout, so nothing scrolls.
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* nothing to scroll */
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

const TARGETS = {
  bmr: 1600,
  tdee: 2200,
  calories: 2100,
  proteinG: 110,
  fatG: 60,
  carbG: 240,
  safetyNotes: [],
}

const DAY = {
  date: '2026-08-25',
  targets: TARGETS,
  totals: { kcal: 1420, proteinG: 62, carbG: 150, fatG: 40 },
  proteinLeftG: 48,
  proteinPct: 56,
  caloriesLeft: 680,
  mealCount: 3,
  confidence: 'rough' as const,
  meals: [],
  notes: [],
}

/** Everything the screens call on mount, quiet by default. */
function stubEverything(): void {
  const quiet: Array<[keyof typeof api, unknown]> = [
    ['today', DAY],
    ['usuals', { usuals: [] }],
    ['proactive', { message: null }],
    ['streak', { currentDays: 0, longestDays: 0, freezesAvailable: 0 }],
    ['history', { turns: [] }],
    ['markers', { series: [] }],
    ['facts', { facts: [] }],
    ['custody', { selfCustody: false, since: null, address: null, publicKey: null }],
    ['proof', { summary: 'ok', total: 0, verified: 0, receipts: [] }],
    [
      'me',
      {
        user: {
          id: 'u1',
          phone: '+919876543210',
          displayName: null,
          sex: 'male',
          ageYears: 28,
          heightCm: 175,
          goal: 'lose',
          diet: 'veg',
          cooks: 'self',
          tone: 'straight',
        },
        onboarded: true,
      },
    ],
  ]

  for (const [name, value] of quiet) {
    vi.spyOn(api, name as never).mockResolvedValue(value as never)
  }
}

/**
 * The rules a component in isolation can be fairly judged on.
 *
 * Landmarks, page titles and html-lang belong to the document rather than to any
 * one screen, and failing them here would say nothing about the product while
 * making the whole check easy to ignore.
 */
const RULES = [
  'aria-allowed-attr',
  'aria-required-attr',
  'aria-roles',
  'aria-valid-attr',
  'aria-valid-attr-value',
  'button-name',
  'image-alt',
  // `image-alt` only covers <img>. A div with role="img" — which is how the
  // progress ring is built — needs this one, and leaving it out meant the
  // check quietly ignored the single most important number on the home screen.
  'role-img-alt',
  'aria-required-children',
  'aria-required-parent',
  'aria-hidden-focus',
  'form-field-multiple-labels',
  'input-button-name',
  'label',
  'link-name',
  'list',
  'listitem',
  'nested-interactive',
  'select-name',
  'duplicate-id-aria',
]

async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    runOnly: { type: 'rule', values: RULES },
  })

  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.length} node(s)) — ` +
      `${violation.nodes[0]?.html?.slice(0, 90) ?? ''}`,
  )
}

describe('every screen, by the rules rather than by eye', () => {
  test('SignIn', async () => {
    render(<SignIn onSignedIn={vi.fn()} />)
    expect(await violations()).toEqual([])
  })

  test('Onboarding', async () => {
    render(<Onboarding onDone={vi.fn()} />)
    expect(await violations()).toEqual([])
  })

  test('Today', async () => {
    stubEverything()
    render(<Today onCapture={vi.fn()} onOpenChat={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.hero')).toBeTruthy())
    expect(await violations()).toEqual([])
  })

  test('Chat', async () => {
    stubEverything()
    render(<Chat />)
    await waitFor(() => expect(document.querySelector('.thread')).toBeTruthy())
    expect(await violations()).toEqual([])
  })

  test('Coach', async () => {
    stubEverything()
    render(<Coach />)
    await waitFor(() => expect(document.querySelector('.panel-tabs')).toBeTruthy())
    expect(await violations()).toEqual([])
  })

  test('MealFlow', async () => {
    render(<MealFlow onClose={vi.fn()} onLogged={vi.fn()} />)
    expect(await violations()).toEqual([])
  })

  test('LabReport', async () => {
    stubEverything()
    render(<LabReport />)
    expect(await violations()).toEqual([])
  })

  test('Remembered', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({
      facts: [
        {
          id: '1',
          kind: 'symptom',
          verbatim: 'knee hurts',
          occurredAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    })
    render(<Remembered />)
    await waitFor(() => expect(document.querySelector('.fact-list')).toBeTruthy())
    expect(await violations()).toEqual([])
  })

  test('Custody', async () => {
    stubEverything()
    render(<Custody />)
    await waitFor(() => expect(document.querySelector('.custody')).toBeTruthy())
    expect(await violations()).toEqual([])
  })
})
