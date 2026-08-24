/**
 * Sign in.
 *
 * A phone number and a six-digit code. No password to forget, no wallet to
 * lose, no email a shared family phone may not have.
 *
 * The details here are deliberate, and each one is a thing that makes people
 * abandon a sign-in screen:
 *
 *   - `inputMode="numeric"` and `autoComplete="one-time-code"`, so the code
 *     autofills from the SMS on both platforms instead of being retyped.
 *   - The number stays visible and editable at the code step. Mistyping a digit
 *     and having no way back is the single most common reason people give up.
 *   - Resend is disabled behind a visible countdown, so nobody taps it four
 *     times and burns their rate limit before the first message arrives.
 *   - The keyboard submits. Hunting for a button after typing six digits is
 *     friction with no purpose.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api.ts'

type Step =
  | { name: 'phone' }
  | { name: 'code'; phone: string; devCode?: string; resendAt: number }

export interface SignInProps {
  onSignedIn: () => void
}

const RESEND_COOLDOWN_SECONDS = 30

export function SignIn({ onSignedIn }: SignInProps) {
  const [step, setStep] = useState<Step>({ name: 'phone' })
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const codeRef = useRef<HTMLInputElement>(null)

  // Drives the resend countdown.
  useEffect(() => {
    if (step.name !== 'code') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [step.name])

  useEffect(() => {
    if (step.name === 'code') codeRef.current?.focus()
  }, [step.name])

  const sendCode = useCallback(
    async (target: string) => {
      setBusy(true)
      setError(null)
      try {
        const result = await api.requestCode(target)
        setStep({
          name: 'code',
          phone: target,
          ...(result.devCode ? { devCode: result.devCode } : {}),
          resendAt: Date.now() + RESEND_COOLDOWN_SECONDS * 1000,
        })
        setCode('')
      } catch (caught) {
        setError(
          caught instanceof ApiError && caught.status === 429
            ? 'Too many codes requested. Try again in an hour.'
            : 'That number does not look right.',
        )
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const verify = useCallback(async () => {
    if (step.name !== 'code' || code.length < 4) return

    setBusy(true)
    setError(null)
    try {
      await api.verifyCode(step.phone, code)
      onSignedIn()
    } catch {
      // The server reports every failure identically on purpose, so we do too.
      setError('That code is wrong or has expired.')
      setCode('')
      codeRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }, [step, code, onSignedIn])

  const secondsLeft =
    step.name === 'code' ? Math.max(0, Math.ceil((step.resendAt - now) / 1000)) : 0

  return (
    <div className="signin">
      <header className="signin-head">
        <h1>
          It asks.
          <br />
          It doesn&rsquo;t guess.
        </h1>
        <p className="muted">
          {step.name === 'phone'
            ? 'Your number, and a code. That is the whole sign-in.'
            : `We sent a code to ${step.phone}.`}
        </p>
      </header>

      {step.name === 'phone' && (
        <form
          className="signin-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (phone.trim()) void sendCode(phone.trim())
          }}
        >
          <label className="field-block">
            <span>Phone number</span>
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="98765 43210"
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="go"
              autoFocus
              aria-label="Phone number"
            />
          </label>

          <button type="submit" className="primary big" disabled={!phone.trim() || busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      )}

      {step.name === 'code' && (
        <form
          className="signin-form"
          onSubmit={(event) => {
            event.preventDefault()
            void verify()
          }}
        >
          <label className="field-block">
            <span>Six-digit code</span>
            <input
              ref={codeRef}
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="••••••"
              // The pair that makes SMS autofill work on iOS and Android.
              inputMode="numeric"
              autoComplete="one-time-code"
              enterKeyHint="go"
              className="code-input"
              aria-label="Six-digit code"
            />
          </label>

          {/* Development only. The server refuses to send this in production. */}
          {step.devCode && (
            <p className="dev-code">
              Development code: <strong>{step.devCode}</strong>
            </p>
          )}

          <button type="submit" className="primary big" disabled={code.length < 4 || busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>

          <div className="signin-actions">
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setStep({ name: 'phone' })
                setError(null)
              }}
            >
              Change number
            </button>

            <button
              type="button"
              className="quiet"
              disabled={secondsLeft > 0 || busy}
              onClick={() => void sendCode(step.phone)}
            >
              {secondsLeft > 0 ? `Resend in ${secondsLeft}s` : 'Resend code'}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <footer className="signin-foot">
        <p className="muted">
          Your food photos and health data are processed inside hardware-sealed enclaves on 0G.
          Nobody — including us — can read them.
        </p>
      </footer>
    </div>
  )
}
