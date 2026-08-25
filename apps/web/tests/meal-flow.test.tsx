/**
 * @vitest-environment jsdom
 *
 * The core loop, as a person actually meets it.
 *
 * This is the product: a plate, at most two questions, a number that says how
 * sure it is. The constitution is proved elsewhere against the planner and the
 * classifier — pure functions, easy to test — and none of that says anything
 * about whether a person ever sees a question or whether the number that reaches
 * the screen carries its confidence. 404 lines of the most important screen in
 * the app had no test at all.
 *
 * So these are about what reaches the glass:
 *
 *   R1/R2 — the questions are asked, one at a time, and never more than two.
 *   R3 — the number arrives with its confidence, and a rough one cannot be
 *        mistaken for a confirmed one.
 *   And the failure everyone gets wrong: an error must not cost somebody the
 *   photograph they already took.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MealFlow } from '../src/screens/MealFlow.tsx'
import { api } from '../src/lib/api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const DRAFT = {
  mealId: 'meal-1',
  items: [{ id: 'i1', name: 'dal', grams: 150, kcal: 180, proteinG: 9 }],
  questions: [
    {
      id: 'q1',
      itemId: 'i1',
      kind: 'portion',
      text: 'How much dal — 1 katori or 2?',
      options: ['1 katori', '2 katori'],
    },
    {
      id: 'q2',
      itemId: 'i1',
      kind: 'cooking_fat',
      text: 'Dal — with ghee or without?',
      options: ['with ghee', 'without'],
    },
  ],
  kcal: 180,
  proteinG: 9,
  confidence: 'rough' as const,
}

/** Takes the photograph, the way the camera would. */
function photograph() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], 'plate.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file] })
  fireEvent.change(input)
}

function renderFlow() {
  const onLogged = vi.fn()
  const onClose = vi.fn()
  render(<MealFlow onClose={onClose} onLogged={onLogged} />)
  return { onLogged, onClose }
}

describe('MealFlow', () => {
  test('R1/R2 — it asks rather than assuming, one question at a time', async () => {
    vi.spyOn(api, 'draftMeal').mockResolvedValue(DRAFT as never)

    renderFlow()
    photograph()

    // The first question, and only the first. Two at once is a form, and the
    // moment somebody has to think, adherence collapses.
    await screen.findByText('How much dal — 1 katori or 2?')
    expect(screen.queryByText('Dal — with ghee or without?')).toBeNull()

    // Their own options, in household units — never grams.
    expect(screen.getByRole('button', { name: '1 katori' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/how many grams/i)
  })

  test('R2 — answering moves on, and the count never exceeds two', async () => {
    vi.spyOn(api, 'draftMeal').mockResolvedValue(DRAFT as never)
    const commit = vi
      .spyOn(api, 'commitMeal')
      .mockResolvedValue({ totals: { kcal: 320, proteinG: 18 }, confidence: 'confirmed' } as never)

    renderFlow()
    photograph()

    await screen.findByText('How much dal — 1 katori or 2?')
    fireEvent.click(screen.getByRole('button', { name: '2 katori' }))

    await screen.findByText('Dal — with ghee or without?')
    fireEvent.click(screen.getByRole('button', { name: 'with ghee' }))

    // Two answered, then it commits. A third question would break the rule the
    // whole product is built on.
    await waitFor(() => expect(commit).toHaveBeenCalled())
    const body = commit.mock.calls[0]![0] as { answers: unknown[] }
    expect(body.answers).toHaveLength(2)
  })

  test('R3 — the number arrives with its confidence', async () => {
    vi.spyOn(api, 'draftMeal').mockResolvedValue(DRAFT as never)
    vi.spyOn(api, 'commitMeal').mockResolvedValue({
      totals: { kcal: 320, proteinG: 18 },
      confidence: 'confirmed',
    } as never)

    renderFlow()
    photograph()

    await screen.findByText('How much dal — 1 katori or 2?')
    fireEvent.click(screen.getByRole('button', { name: '2 katori' }))
    await screen.findByText('Dal — with ghee or without?')
    fireEvent.click(screen.getByRole('button', { name: 'with ghee' }))

    await screen.findByText('18g')
    expect(document.body.textContent).toContain('320 kcal')

    /*
     * A confirmed number must not look like a guess, and a guess must not look
     * like a barcode. The badge is the only thing on the screen carrying that
     * difference.
     */
    expect(document.body.textContent?.toLowerCase()).toMatch(/confirmed|you told/)
  })

  test('a plate with nothing worth asking about goes straight to the number', async () => {
    // R4 — day 30 asks nothing. The person who has already told us about their
    // dal must not be asked about it again.
    vi.spyOn(api, 'draftMeal').mockResolvedValue({ ...DRAFT, questions: [] } as never)
    vi.spyOn(api, 'commitMeal').mockResolvedValue({
      totals: { kcal: 180, proteinG: 9 },
      confidence: 'confirmed',
    } as never)

    renderFlow()
    photograph()

    await screen.findByText('9g')
    expect(screen.queryByText(/How much dal/)).toBeNull()
  })

  test('an error does not cost them the photograph they already took', async () => {
    const draft = vi.spyOn(api, 'draftMeal').mockRejectedValueOnce(new Error('flaky network'))

    renderFlow()
    photograph()

    // Offered a retry of what was sent — not asked to photograph the plate
    // again, which by then may be half eaten.
    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByRole('button', { name: 'Take another photo' })).toBeTruthy()

    draft.mockResolvedValueOnce(DRAFT as never)
    fireEvent.click(retry)

    // The same photograph, read successfully the second time.
    await screen.findByText('How much dal — 1 katori or 2?')
    expect(draft).toHaveBeenCalledTimes(2)
    expect(draft.mock.calls[1]![0]).toBe(draft.mock.calls[0]![0])
  })

  test('a raw failure is never shown to the person', async () => {
    vi.spyOn(api, 'draftMeal').mockRejectedValue(new Error('ECONNRESET at socket.js:214'))

    renderFlow()
    photograph()

    await screen.findByRole('button', { name: 'Try again' })
    expect(document.body.textContent).not.toContain('ECONNRESET')
    expect(document.body.textContent).not.toContain('socket.js')
  })

  test('something that is not food says so, and offers the way back', async () => {
    vi.spyOn(api, 'draftMeal').mockResolvedValue({
      notFood: true,
      message: 'That looks like a bicycle.',
    } as never)

    renderFlow()
    photograph()

    await screen.findByText('That looks like a bicycle.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
