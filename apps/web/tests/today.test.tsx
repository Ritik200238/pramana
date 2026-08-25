/**
 * @vitest-environment jsdom
 *
 * Today — the screen people open without deciding to.
 *
 * What is tested here is what a person can act on: whether the ring means
 * anything to somebody who cannot see it, whether "log again" is really one tap
 * and no questions, and whether the day's number admits how sure it is.
 *
 * The day's confidence badge is the one that matters most and is easiest to
 * quietly drop. R3 says a day is only as good as its weakest entry — a day that
 * looks precise because the number has no badge is exactly the false precision
 * the whole product exists to avoid.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Today } from '../src/screens/Today.tsx'
import { api } from '../src/lib/api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

const USUAL = {
  sourceMealId: 'meal-9',
  label: 'dal, rice, curd',
  kcal: 480,
  proteinG: 21,
  timesEaten: 7,
  lastEatenAt: '2026-08-24T12:00:00.000Z',
  mealType: 'lunch',
  itemCount: 3,
}

function renderToday() {
  // Called on mount regardless; silence is its normal state.
  if (!vi.isMockFunction(api.proactive)) {
    vi.spyOn(api, 'proactive').mockResolvedValue({ message: null } as never)
  }

  const onCapture = vi.fn()
  const onOpenChat = vi.fn()
  render(<Today onCapture={onCapture} onOpenChat={onOpenChat} />)
  return { onCapture, onOpenChat }
}

describe('Today', () => {
  test('the ring says the same thing to somebody who cannot see it', async () => {
    vi.spyOn(api, 'today').mockResolvedValue(DAY as never)
    vi.spyOn(api, 'usuals').mockResolvedValue({ usuals: [] } as never)

    renderToday()

    // A ring is a picture. Without a label it is decoration to a screen reader,
    // and the single number the whole screen exists to convey is lost.
    const ring = await screen.findByRole('img')
    expect(ring.getAttribute('aria-label')).toMatch(/62 of 110 grams of protein/)
  })

  test('R3 — the day carries its confidence', async () => {
    vi.spyOn(api, 'today').mockResolvedValue(DAY as never)
    vi.spyOn(api, 'usuals').mockResolvedValue({ usuals: [] } as never)

    renderToday()

    await screen.findByRole('img')

    // A day built from estimates must not read as a measurement.
    expect(document.body.textContent?.toLowerCase()).toMatch(/rough|estimated|we estimated/)
  })

  test('an empty day is not dressed up as progress', async () => {
    vi.spyOn(api, 'today').mockResolvedValue({
      ...DAY,
      totals: { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 },
      proteinLeftG: 110,
      proteinPct: 0,
      mealCount: 0,
    } as never)
    vi.spyOn(api, 'usuals').mockResolvedValue({ usuals: [] } as never)

    renderToday()

    const ring = await screen.findByRole('img')
    expect(ring.getAttribute('aria-label')).toMatch(/0 of 110/)

    // No badge on a day with nothing in it: a confidence rating for zero meals
    // is a statement about nothing.
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/rough|confirmed/)
  })

  test('R4 — a usual is one tap and no questions', async () => {
    vi.spyOn(api, 'today').mockResolvedValue(DAY as never)
    vi.spyOn(api, 'usuals').mockResolvedValue({ usuals: [USUAL] } as never)
    const repeat = vi.spyOn(api, 'repeatMeal').mockResolvedValue({ ok: true } as never)

    renderToday()

    const button = await screen.findByRole('button', { name: /dal, rice, curd/i })
    fireEvent.click(button)

    // Straight to logged. Asking again about a meal they have already told us
    // about is the friction R4 exists to remove.
    await waitFor(() => expect(repeat).toHaveBeenCalledWith(USUAL.sourceMealId))
    expect(screen.queryByText(/how much/i)).toBeNull()
  })

  test('a usual cannot be double-logged by tapping twice', async () => {
    vi.spyOn(api, 'today').mockResolvedValue(DAY as never)
    vi.spyOn(api, 'usuals').mockResolvedValue({ usuals: [USUAL] } as never)
    const repeat = vi
      .spyOn(api, 'repeatMeal')
      .mockImplementation(() => new Promise(() => {}) as never)

    renderToday()

    const button = await screen.findByRole('button', { name: /dal, rice, curd/i })
    fireEvent.click(button)
    fireEvent.click(button)

    // Two taps on a slow connection is one meal, not two. The day's totals are
    // the thing people check, and a doubled meal quietly ruins them.
    await waitFor(() => expect(repeat).toHaveBeenCalledTimes(1))
  })

  test('a day that will not load does not pretend the totals are zero', async () => {
    vi.spyOn(api, 'today').mockRejectedValue(new Error('offline'))
    vi.spyOn(api, 'usuals').mockRejectedValue(new Error('offline'))

    renderToday()

    /*
     * Showing 0g of protein to somebody who has eaten is worse than showing
     * nothing: they act on it. Either the screen says something is wrong, or it
     * shows no totals at all — what it must not do is present a failure as a
     * fact about their day.
     */
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      const claimsAnEmptyDay = /0\s*\/\s*110/.test(text)
      const admitsTrouble = /offline|could not|try again|trouble/i.test(text)
      expect(claimsAnEmptyDay && !admitsTrouble).toBe(false)
    })
  })
})
