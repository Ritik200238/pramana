/**
 * @vitest-environment jsdom
 *
 * The first ninety seconds.
 *
 * Onboarding is where a product loses people before it has done anything for
 * them, and it is also where this one makes its promise: five taps, then log a
 * meal. Everything tested here is about that promise being kept — that a step is
 * one decision, that the last tap actually starts the account rather than
 * needing a separate submit, and that the two failures possible here are handled
 * as what they are.
 *
 * The safety gate matters more than anything else on this screen. Somebody
 * entering a goal weight that would harm them is not making a mistake to be
 * validated against; they are telling us something, and the response has to be a
 * person's response rather than a form error.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Onboarding } from '../src/screens/Onboarding.tsx'
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

/** Walks the five steps, taking the first option each time. */
async function walkThrough() {
  fireEvent.click(await screen.findByRole('button', { name: /lose weight/i }))
  fireEvent.click(await screen.findByRole('button', { name: /continue|next/i }))
  fireEvent.click(await screen.findByRole('button', { name: /a bit of walking/i }))
  fireEvent.click(await screen.findByRole('button', { name: /^vegetarian$/i }))
  fireEvent.click(await screen.findByRole('button', { name: /i cook/i }))
}

describe('Onboarding', () => {
  test('it opens with the promise the product is named for', () => {
    render(<Onboarding onDone={vi.fn()} />)

    // The thesis, on the first screen, before anything is asked.
    expect(document.body.textContent).toMatch(/asks/i)
    expect(document.body.textContent).toMatch(/does.{0,3}n.{0,3}t guess/i)
  })

  test('a step is one decision, and choosing moves on by itself', async () => {
    render(<Onboarding onDone={vi.fn()} />)

    // No "next" to hunt for after a choice: the tap is the answer. A separate
    // confirm on every step doubles the taps for no information.
    fireEvent.click(await screen.findByRole('button', { name: /lose weight/i }))
    await screen.findByText('The basics')
    expect(screen.queryByRole('button', { name: /lose weight/i })).toBeNull()
  })

  test('the last tap creates the account — there is no separate submit', async () => {
    const create = vi.spyOn(api, 'createProfile').mockResolvedValue({ targets: TARGETS } as never)
    const onDone = vi.fn()

    render(<Onboarding onDone={onDone} />)
    await walkThrough()

    await waitFor(() => expect(create).toHaveBeenCalled())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(TARGETS))
  })

  test('the safety gate is answered as a person, not as a validation error', async () => {
    vi.spyOn(api, 'createProfile').mockResolvedValue({
      blocked: true,
      message: 'That is a weight I should not help you reach. Can we talk about it?',
      helpline: { label: 'Vandrevala Foundation', number: '9999666555' },
    } as never)

    render(<Onboarding onDone={vi.fn()} />)
    await walkThrough()

    const message = await screen.findByText(/should not help you reach/i)
    expect(message).toBeTruthy()

    /*
     * Somebody disclosing this has not made a mistake, and the interface must
     * not treat them as though they filled a form in wrong. No error styling,
     * and the helpline is offered as something to press.
     */
    expect(document.body.textContent).not.toMatch(/invalid|error|try again/i)
    const helpline = screen.getByRole('link', { name: /9999666555|vandrevala/i })
    expect(helpline.getAttribute('href')).toBe('tel:9999666555')
  })

  test('a failure in the first ninety seconds is announced, not silent', async () => {
    vi.spyOn(api, 'createProfile').mockRejectedValue(new Error('offline'))

    render(<Onboarding onDone={vi.fn()} />)
    await walkThrough()

    // role="alert" so a screen reader hears it. A silent failure here is the
    // single worst moment for one, because nothing on screen has changed and
    // the person has no idea whether their taps did anything.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/could not save/i)
    expect(alert.textContent).not.toContain('offline')
  })
})
