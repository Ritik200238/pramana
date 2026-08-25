/**
 * @vitest-environment jsdom
 *
 * What we remember, and closing a topic.
 *
 * The schema says why this control exists: "a resolved fact is NEVER raised
 * again by the proactive engine — this column exists because of a documented
 * harm: a coach that kept surfacing a healed injury for three months and then
 * argued with the user about it."
 *
 * That control shipped with no way to reach it, so the harm it prevents was
 * unprevented. These tests are about the two things that decide whether the
 * screen is worth having: that a person sees their own words rather than our
 * summary of them, and that saying "sorted" actually closes the topic.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Remembered } from '../src/components/Remembered.tsx'
import { api } from '../src/lib/api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const KNEE = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'symptom',
  verbatim: 'my knee has been hurting since Tuesday',
  occurredAt: '2026-08-04T09:00:00.000Z',
}

const SLEEP = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'sleep',
  verbatim: 'slept badly all week',
  occurredAt: '2026-08-06T09:00:00.000Z',
}

describe('Remembered', () => {
  test('it shows their words, not our summary of them', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [KNEE, SLEEP] })

    render(<Remembered />)

    // Verbatim, both of them. A paraphrase presented as what somebody said is a
    // small betrayal, and on a screen about being remembered accurately it is
    // the entire subject.
    await screen.findByText(/my knee has been hurting since Tuesday/)
    expect(document.body.textContent).toContain('slept badly all week')

    // Kinds in plain words. Nobody thinks in enum values.
    expect(document.body.textContent).toContain('Something bothering you')
    expect(document.body.textContent).not.toContain('symptom')
  })

  test('saying it is sorted closes the topic and stops showing it', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [KNEE, SLEEP] })
    const resolve = vi.spyOn(api, 'resolveFact').mockResolvedValue({ resolved: true })

    render(<Remembered />)
    await screen.findByText(/my knee has been hurting/)

    const buttons = await screen.findAllByRole('button', { name: 'This is sorted' })
    fireEvent.click(buttons[0]!)

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(KNEE.id))

    // Gone from the screen straight away. Leaving it up while a request lands
    // reads as though we did not listen — which is exactly the failure the
    // resolve column was added to prevent.
    await waitFor(() =>
      expect(document.body.textContent).not.toContain('my knee has been hurting'),
    )

    // And only that one. The other topic is still open.
    expect(document.body.textContent).toContain('slept badly all week')
  })

  test('it says what resolving does, because "sorted" could read as "delete"', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [KNEE] })

    render(<Remembered />)
    await screen.findByText(/my knee has been hurting/)

    // R6 is "nothing said to us is ever thrown away". Offering a delete we do
    // not perform would be worse than offering nothing.
    expect(document.body.textContent).toContain('Nothing is deleted')
    expect(document.body.textContent).toContain('stops being raised')
  })

  test('nothing open is a calm sentence, not an empty box', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [] })

    render(<Remembered />)

    // It also says where these come from, since somebody looking at an empty
    // list has no way to know what would ever appear in it.
    await screen.findByText(/Nothing open right now/)
    expect(document.body.textContent).toContain('mention in chat')
  })

  test('a failed close says so and keeps the topic on screen', async () => {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [KNEE] })
    vi.spyOn(api, 'resolveFact').mockRejectedValue(new Error('nope'))

    render(<Remembered />)
    await screen.findByText(/my knee has been hurting/)

    fireEvent.click(screen.getByRole('button', { name: 'This is sorted' }))

    await screen.findByText(/did not save/i)

    // Still there, because it is still open. Removing it on a failure would
    // tell somebody a topic was closed when the coach will raise it again.
    expect(document.body.textContent).toContain('my knee has been hurting')
  })

  test('the screen is reachable', () => {
    const you = readFileSync(
      join(import.meta.dirname, '..', 'src', 'screens', 'You.tsx'),
      'utf8',
    )
    expect(you).toContain('<Remembered />')
  })
})
