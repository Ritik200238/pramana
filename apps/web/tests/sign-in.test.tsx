/**
 * @vitest-environment jsdom
 *
 * Signing in — the screen everybody meets first, and the one most likely to
 * lose them.
 *
 * The failures worth testing here are not layout. They are the ones that decide
 * whether somebody on a slow connection, holding a phone, waiting for an SMS,
 * gets in at all: a keyboard that is the wrong kind, a resend button that
 * invites a second code before the first has arrived, a double-tap that spends
 * a code twice, and an error that tells an attacker which phone numbers exist.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SignIn } from '../src/screens/SignIn.tsx'
import { api, ApiError } from '../src/lib/api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function enterPhone(value = '9876543210') {
  const field = document.querySelector('input[type="tel"]') as HTMLInputElement
  fireEvent.change(field, { target: { value } })
  return field
}

/** The code field, once the first step has actually advanced. */
async function codeField(): Promise<HTMLInputElement> {
  // Asserted inside, because `waitFor` resolves the moment its callback stops
  // throwing — and querySelector returning null throws nothing, so waiting on
  // it alone would hand back null immediately.
  return await waitFor(() => {
    const field = document.querySelector('input[inputmode="numeric"]')
    expect(field).not.toBeNull()
    return field as HTMLInputElement
  })
}

/** An error shaped the way the client builds one from a 4xx body. */
function serverError(status: number, code: string, humanMessage: string): ApiError {
  const error = new ApiError(code, status, code)
  error.humanMessage = humanMessage
  return error
}

describe('SignIn', () => {
  test('the phone field asks for the right keyboard', () => {
    render(<SignIn onSignedIn={vi.fn()} />)

    const field = document.querySelector('input[type="tel"]') as HTMLInputElement
    // A text keyboard for a phone number is a small cruelty that costs a real
    // number of sign-ins on a phone.
    expect(field.getAttribute('inputMode')).toBe('tel')
  })

  test('the code field is set up so the SMS can fill it', async () => {
    vi.spyOn(api, 'requestCode').mockResolvedValue({ sent: true, expiresInSeconds: 300 })

    render(<SignIn onSignedIn={vi.fn()} />)
    enterPhone()
    fireEvent.click(screen.getByRole('button', { name: /send|continue|get/i }))

    const field = await codeField()
    // The one attribute that lets a phone offer the code from the SMS itself,
    // turning four taps into one.
    expect(field.getAttribute('autocomplete')).toBe('one-time-code')
  })

  test('a wrong code says nothing about whether the number exists', async () => {
    vi.spyOn(api, 'requestCode').mockResolvedValue({ sent: true, expiresInSeconds: 300 })
    vi.spyOn(api, 'verifyCode').mockRejectedValue(serverError(400, 'bad_code', 'no'))

    render(<SignIn onSignedIn={vi.fn()} />)
    enterPhone()
    fireEvent.click(screen.getByRole('button', { name: /send|continue|get/i }))

    const field = await codeField()
    fireEvent.change(field, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /verify|sign in|continue/i }))

    const message = await screen.findByText(/wrong or has expired/i)

    /*
     * One sentence for every failure. "No account with that number" is a free
     * membership oracle for anybody willing to try numbers, and this is a
     * health app — knowing somebody has an account is itself information.
     */
    expect(message.textContent).not.toMatch(/no account|not registered|unknown number/i)
  })

  test('the code cannot be submitted twice by tapping twice', async () => {
    vi.spyOn(api, 'requestCode').mockResolvedValue({ sent: true, expiresInSeconds: 300 })
    const verify = vi
      .spyOn(api, 'verifyCode')
      .mockImplementation(() => new Promise(() => {}) as never)

    render(<SignIn onSignedIn={vi.fn()} />)
    enterPhone()
    fireEvent.click(screen.getByRole('button', { name: /send|continue|get/i }))

    const field = await codeField()
    fireEvent.change(field, { target: { value: '123456' } })

    const submit = screen.getByRole('button', { name: /verify|sign in|continue/i })
    fireEvent.click(submit)
    fireEvent.click(submit)

    // A one-time code spent twice is a failed sign-in and a support message.
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
  })

  test('resending is refused until the first code has had time to arrive', async () => {
    vi.spyOn(api, 'requestCode').mockResolvedValue({ sent: true, expiresInSeconds: 300 })

    render(<SignIn onSignedIn={vi.fn()} />)
    enterPhone()
    fireEvent.click(screen.getByRole('button', { name: /send|continue|get/i }))

    const resend = await screen.findByRole('button', { name: /resend|again/i })

    // Indian SMS routinely takes twenty seconds. An immediately-available
    // resend produces two codes, the first of which then fails — which is the
    // exact moment people give up.
    expect((resend as HTMLButtonElement).disabled).toBe(true)
  })

  test('a rate-limited request says what the server said, not our guess', async () => {
    vi.spyOn(api, 'requestCode').mockRejectedValue(
      serverError(429, 'too_many_codes', 'Too many codes requested. Try again in a few minutes.'),
    )

    render(<SignIn onSignedIn={vi.fn()} />)
    enterPhone()
    fireEvent.click(screen.getByRole('button', { name: /send|continue|get/i }))

    // "That number does not look right" would be a lie here, and would send
    // somebody to correct a number that was never the problem.
    await screen.findByText(/too many codes/i)
    expect(document.body.textContent).not.toMatch(/does not look right/i)
  })
})
