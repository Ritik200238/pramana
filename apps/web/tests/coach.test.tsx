/**
 * @vitest-environment jsdom
 *
 * The coach — four panels of the same promise, which is that it never makes
 * anything up.
 *
 * A coaching screen fails in one direction that matters. Asked for a weekly
 * review after two logged meals, the tempting thing is to produce a paragraph;
 * it reads well, it is entirely invented, and a person acts on it. So the
 * behaviour tested here is mostly restraint: not enough data says so, a
 * question it cannot answer says so, and an answer it does give is announced
 * politely rather than appearing in silence.
 *
 * The safety gate runs through all of it. "What should I eat" and "ask your own
 * data" both reach a model with somebody's health record, and either can be
 * asked something that needs a person rather than a coach.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Coach } from '../src/screens/Coach.tsx'
import { api, ApiError } from '../src/lib/api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Every call the screen makes on mount, quiet by default. */
function renderCoach() {
  if (!vi.isMockFunction(api.streak)) {
    vi.spyOn(api, 'streak').mockResolvedValue({
      currentDays: 0,
      longestDays: 0,
      freezesAvailable: 0,
    } as never)
  }
  render(<Coach />)
}

async function openTab(name: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name }))
}

describe('Coach', () => {
  test('a week with too little in it says so instead of inventing a review', async () => {
    vi.spyOn(api, 'weekly').mockResolvedValue({
      review: null,
      message: 'Two days logged so far. Give it a few more and this gets useful.',
    } as never)

    renderCoach()
    await openTab(/this week/i)

    /*
     * The failure worth preventing: a fluent paragraph assembled from two data
     * points. It reads well, it is invented, and somebody changes what they eat
     * because of it.
     */
    await screen.findByText(/give it a few more/i)
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('a review it does have is announced rather than appearing in silence', async () => {
    vi.spyOn(api, 'weekly').mockResolvedValue({
      review: 'Protein was short on four days, all of them weekdays.',
      message: null,
    } as never)

    renderCoach()
    await openTab(/this week/i)

    const answer = await screen.findByRole('status')
    expect(answer.getAttribute('aria-live')).toBe('polite')
    expect(answer.textContent).toMatch(/short on four days/)
  })

  test('a question about their own data cannot be sent empty', async () => {
    const ask = vi.spyOn(api, 'ask')

    renderCoach()
    await openTab(/^ask$/i)

    // Scoped to the form: the tab is also called "Ask", and matching the tab
    // instead would assert that a navigation control is disabled.
    const field = await screen.findByLabelText(/question about your data/i)
    const form = field.closest('form') as HTMLFormElement
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement

    expect(submit.disabled).toBe(true)

    fireEvent.submit(form)
    expect(ask).not.toHaveBeenCalled()
  })

  test('a question it cannot answer says so rather than guessing', async () => {
    vi.spyOn(api, 'ask').mockResolvedValue({
      answer: null,
      notice: 'I do not have enough logged to answer that yet.',
    } as never)

    renderCoach()
    await openTab(/^ask$/i)

    const field = await screen.findByLabelText(/question about your data/i)
    fireEvent.change(field, { target: { value: 'how much protein did I average in June?' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)

    // Admitting the gap is the whole value of asking your own data rather than
    // a chatbot: an answer that might be invented is worth nothing here.
    const notice = await screen.findByRole('note')
    expect(notice.textContent).toMatch(/not have enough logged/i)
  })

  test('a rate-limited coach repeats the server, not our guess', async () => {
    const error = new ApiError('too_many', 429, 'too_many')
    error.humanMessage = 'That is a lot of questions at once — give it a minute.'
    vi.spyOn(api, 'suggest').mockRejectedValue(error)

    renderCoach()
    await openTab(/eat now/i)
    fireEvent.click(await screen.findByRole('button', { name: /tell me/i }))

    await screen.findByText(/a lot of questions at once/i)
    expect(document.body.textContent).not.toMatch(/could not reach the coach/i)
  })

  test('a disclosure while asking for a meal is handled as a disclosure', async () => {
    vi.spyOn(api, 'suggest').mockResolvedValue({
      blocked: true,
      message: 'That sounds like a hard place to be, and it is bigger than food.',
      helpline: { label: 'Vandrevala Foundation', number: '9999666555' },
    } as never)

    renderCoach()
    await openTab(/eat now/i)
    fireEvent.click(await screen.findByRole('button', { name: /tell me/i }))

    await screen.findByText(/bigger than food/i)

    // Not an error, and the helpline is a thing to press. The gate reaches this
    // panel too — somebody can say anything to a box that asks what they have.
    expect(document.body.textContent).not.toMatch(/invalid|error|declined/i)
    const helpline = await screen.findByRole('link', { name: /9999666555|vandrevala/i })
    expect(helpline.getAttribute('href')).toBe('tel:9999666555')
  })

  test('a streak is shown as banked rest days, never as a used-up allowance', async () => {
    vi.spyOn(api, 'streak').mockResolvedValue({
      currentDays: 12,
      longestDays: 20,
      freezesAvailable: 1,
    } as never)

    renderCoach()

    await screen.findByText('12')

    /*
     * Duolingo's lesson: forgiveness keeps people, guilt loses them. A freeze
     * presented as "you used one" is an accusation for something the product
     * gave them on purpose.
     */
    expect(document.body.textContent).toMatch(/rest day/i)
    expect(document.body.textContent).not.toMatch(/used|missed|broke/i)
  })
})
