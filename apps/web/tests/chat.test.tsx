/**
 * @vitest-environment jsdom
 *
 * The place a person says things that are not food.
 *
 * R6 lives here: anything they say — mood, sleep, a symptom, a bad week — enters
 * the record and stays. What this screen has to get right is that saying it
 * costs nothing and never gets lost, including when the network fails on the way.
 *
 * The safety path matters more than the coaching. Somebody disclosing purging or
 * self-harm is not making a request to be declined; the reply has to be a
 * person's reply, their words still have to be kept, and the helpline has to be
 * the thing on screen that is easiest to press.
 */

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Chat } from '../src/screens/Chat.tsx'
import { api, ApiError } from '../src/lib/api.ts'

// jsdom implements no layout, so it has no scrollIntoView. The component is
// right to call it; this supplies the method the environment lacks.
beforeAll(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* no layout to scroll */
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderChat() {
  vi.spyOn(api, 'history').mockResolvedValue({ turns: [] } as never)
  render(<Chat onClose={vi.fn()} />)
}

async function say(words: string) {
  const field = await screen.findByPlaceholderText(/slept badly/i)
  fireEvent.change(field, { target: { value: words } })
  fireEvent.submit(field.closest('form') as HTMLFormElement)
}

describe('Chat', () => {
  test('what they said appears immediately, before any reply', async () => {
    vi.spyOn(api, 'chat').mockImplementation(() => new Promise(() => {}) as never)

    renderChat()
    await say('slept badly all week')

    /*
     * Optimistic on purpose. On a slow connection a message that vanishes into
     * a spinner reads as lost, and the person retypes it — which is how the same
     * thing ends up in the record twice.
     */
    await screen.findByText('slept badly all week')
  })

  test('the thread announces new turns to a screen reader', () => {
    renderChat()

    const thread = document.querySelector('.thread')
    // Without this, replies arrive silently and somebody using a screen reader
    // has no idea the coach answered.
    expect(thread?.getAttribute('aria-live')).toBe('polite')
  })

  test('an empty message cannot be sent', async () => {
    const chat = vi.spyOn(api, 'chat')

    renderChat()
    const field = await screen.findByPlaceholderText(/slept badly/i)
    fireEvent.submit(field.closest('form') as HTMLFormElement)

    expect(chat).not.toHaveBeenCalled()
  })

  test('a failed send keeps their words on screen and says what happened', async () => {
    const error = new ApiError('too_many', 429, 'too_many')
    error.humanMessage = 'Slow down a moment — try again shortly.'
    vi.spyOn(api, 'chat').mockRejectedValue(error)

    renderChat()
    await say('my knee is bad again')

    // Their words survive the failure. Losing what somebody just told you is
    // the exact opposite of "nothing said to us is ever thrown away".
    await screen.findByText('my knee is bad again')

    // And the server's own wording, which knows why, rather than our guess.
    await screen.findByText(/slow down a moment/i)
  })

  test('a disclosure is answered as a person, with the helpline to press', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue({
      blocked: true,
      message: 'That sounds really hard, and it is not something I can help with alone.',
      helpline: { label: 'Vandrevala Foundation', number: '9999666555' },
    } as never)

    renderChat()
    await say('i have been making myself sick after meals')

    await screen.findByText(/not something I can help with alone/i)

    // Not framed as a refusal, and not as an error.
    expect(document.body.textContent).not.toMatch(/cannot process|invalid|error|declined/i)

    // One tap to a human. If it is on screen at all it should not be a footnote.
    const helpline = await screen.findByRole('link', { name: /9999666555|vandrevala/i })
    expect(helpline.getAttribute('href')).toBe('tel:9999666555')

    /*
     * The panel takes the whole screen on purpose — a disclosure deserves the
     * screen rather than a line in a thread. What matters is that closing it
     * returns them to everything they said, still there. A disclosure is the
     * last thing that should be dropped, and R6 says nothing is.
     */
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    await screen.findByText('i have been making myself sick after meals')
  })

  test('a reply the coach did not understand says so rather than bluffing', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue({
      reply: 'Noted.',
      understood: false,
      notice: 'I did not catch what that referred to — tell me again?',
    } as never)

    renderChat()
    await say('it was the thing from before')

    // A coach that answers confidently about something it did not follow is
    // how people stop trusting the ones that do follow.
    const notice = await screen.findByRole('note')
    expect(notice.textContent).toMatch(/did not catch/i)
  })
})
