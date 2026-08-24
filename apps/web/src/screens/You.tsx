/**
 * You.
 *
 * This screen exists because a sweep found twelve client methods that no screen
 * called — twelve features built, tested, shipped in the API, and reachable by
 * nobody. The worst three are all here:
 *
 *   - There was no way to sign out. On a shared phone, which is the normal case
 *     in the market this is built for, that is not a missing convenience.
 *   - The attestation receipts were invisible. The sign-in screen tells people
 *     their food photographs are processed inside sealed hardware, and the
 *     evidence for that sentence existed only as an endpoint.
 *   - "Export everything, free, forever" had no button, which makes it a
 *     sentence rather than a promise.
 *
 * The proof panel is deliberately the first thing on the screen. A privacy
 * claim a user cannot check is marketing; one they can check is a feature.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, type Me, type ProofReceipt } from '../lib/api.ts'

export interface YouProps {
  onSignedOut: () => void
}

type Tone = 'gentle' | 'straight' | 'blunt'

export function You({ onSignedOut }: YouProps) {
  const [me, setMe] = useState<Me | null>(null)
  const [proof, setProof] = useState<{
    total: number
    verified: number
    summary: string
    receipts: ProofReceipt[]
  } | null>(null)
  const [showReceipts, setShowReceipts] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [weight, setWeight] = useState('')

  useEffect(() => {
    api.me().then(setMe).catch(() => undefined)
    api
      .proof()
      .then(setProof)
      .catch(() => {
        // Offline. The rest of the screen still works.
      })
  }, [])

  const changeTone = useCallback(async (tone: Tone) => {
    setBusy('tone')
    try {
      await api.setTone(tone)
      setMe((current) => (current ? { ...current, user: { ...current.user, tone } } : current))
    } catch {
      setNote('Could not save that just now.')
    } finally {
      setBusy(null)
    }
  }, [])

  const askLess = useCallback(async () => {
    setBusy('ask-less')
    try {
      await api.askMeLess()
      // Obeyed permanently and never re-prompted, so the confirmation says so.
      setNote('Done. The coach will not start conversations any more.')
    } catch {
      setNote('Could not save that just now.')
    } finally {
      setBusy(null)
    }
  }, [])

  /*
   * Weight is what keeps the targets honest.
   *
   * Targets are recomputed from the most recent weight, so with no way to log
   * one after onboarding they were frozen at whatever somebody typed on their
   * first day — and a coach working from a months-old number gives advice that
   * quietly stops applying.
   */
  const saveWeight = useCallback(async () => {
    const value = Number(weight)
    if (!Number.isFinite(value) || value < 20 || value > 400) {
      setNote('That does not look like a weight in kilograms.')
      return
    }

    setBusy('weight')
    try {
      await api.logWeight(value)
      setWeight('')
      // No congratulation and no comparison to last time. A number going the
      // wrong way is not an occasion for the app to have an opinion.
      setNote('Logged.')
    } catch {
      setNote('Could not save that just now.')
    } finally {
      setBusy(null)
    }
  }, [weight])

  const signOut = useCallback(async () => {
    setBusy('signout')
    try {
      await api.signOut()
    } finally {
      // The local token is cleared either way. A failed sign-out that leaves
      // somebody signed in on a borrowed phone is the worst outcome here.
      onSignedOut()
    }
  }, [onSignedOut])

  const verifiedAll = proof !== null && proof.total > 0 && proof.verified === proof.total

  return (
    <section className="you">
      <p className="eyebrow">You</p>

      {/* ---------------------------------------------------------- proof */}
      <section className={verifiedAll ? 'proof proof-verified' : 'proof'}>
        <h2>Where your data was processed</h2>

        {proof === null && <p className="muted">Checking…</p>}

        {proof !== null && (
          <>
            <p className="proof-summary">{proof.summary}</p>

            {proof.total > 0 && (
              <>
                <div className="proof-count">
                  <strong>{proof.verified}</strong>
                  <span>of {proof.total} verified by 0G</span>
                </div>

                <button
                  type="button"
                  className="quiet"
                  onClick={() => setShowReceipts((open) => !open)}
                  aria-expanded={showReceipts}
                >
                  {showReceipts ? 'Hide receipts' : 'Show the receipts'}
                </button>

                {/*
                  * What this does and does not prove, in the place somebody is
                  * actually deciding whether to believe it.
                  *
                  * 0G's documentation is explicit that verify_tee returns the
                  * Router's word that it checked the provider's signature, not
                  * the signature itself. Our copy claimed more than that, and a
                  * privacy claim that overstates its evidence is worse than a
                  * smaller one that holds.
                  */}
                <details className="trust-note">
                  <summary>What does &ldquo;verified&rdquo; actually mean?</summary>
                  <p>
                    Each provider runs inside sealed hardware and signs what it computes. 0G
                    checks that signature against the provider&rsquo;s registered address on
                    chain and tells us the result. You get the provider&rsquo;s address and a
                    request id, so a claim is traceable to a specific machine and moment.
                  </p>
                  <p>
                    What you do not get is the signature itself, so this rests on 0G having
                    done the check honestly. It is a receipt, not a proof you can re-run.
                  </p>
                  <p>
                    Separately: your stored records are encrypted to a key we currently hold on
                    your behalf, because signing in is a phone number and nothing else. We can
                    read them. Moving that key onto your device is the next thing to change.
                  </p>
                </details>
              </>
            )}

            {showReceipts && (
              <ul className="receipts">
                {proof.receipts.map((receipt) => (
                  <li key={`${receipt.requestId ?? receipt.createdAt}`} className="receipt">
                    <div className="receipt-head">
                      <span className="receipt-task">{receipt.task}</span>
                      <span className={`receipt-badge receipt-${receipt.attestation}`}>
                        {receipt.attestation === 'verified' ? 'sealed' : receipt.attestation}
                      </span>
                    </div>
                    <div className="receipt-meta">
                      {receipt.model}
                      {receipt.provider ? ` · ${receipt.provider.slice(0, 10)}…` : ''}
                    </div>
                    {/* The explorer link is what makes this checkable by
                        somebody who does not trust us, which is the point. */}
                    {receipt.explorer && (
                      <a href={receipt.explorer} target="_blank" rel="noreferrer noopener">
                        Check it on the explorer →
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* ----------------------------------------------------------- tone */}
      <section className="panel">
        <h2>How the coach talks</h2>
        <p className="muted">Never flattering at any setting. This only changes how blunt it is.</p>

        <div className="options options-row">
          {(['gentle', 'straight', 'blunt'] as const).map((tone) => (
            <button
              key={tone}
              type="button"
              className={me?.user.tone === tone ? 'option option-on' : 'option'}
              onClick={() => void changeTone(tone)}
              disabled={busy === 'tone'}
              aria-pressed={me?.user.tone === tone}
            >
              {tone}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="quiet"
          onClick={() => void askLess()}
          disabled={busy === 'ask-less'}
        >
          Ask me less
        </button>
      </section>

      {/* --------------------------------------------------------- weight */}
      <section className="panel">
        <h2>Weight</h2>
        <p className="muted">Your targets are recalculated from the most recent one.</p>

        <form
          className="ask-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveWeight()
          }}
        >
          <input
            type="text"
            value={weight}
            onChange={(event) => setWeight(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="kg"
            inputMode="decimal"
            aria-label="Weight in kilograms"
            enterKeyHint="done"
          />
          <button type="submit" className="primary" disabled={!weight || busy === 'weight'}>
            {busy === 'weight' ? '…' : 'Log'}
          </button>
        </form>
      </section>

      {/* --------------------------------------------------------- export */}
      <section className="panel">
        <h2>Your data</h2>
        <p className="muted">
          Everything you have logged, in a file you keep. No charge, no cancellation flow.
        </p>

        <div className="export-actions">
          {/* A plain link rather than a fetch: the browser downloads it, and
              the session cookie rides along. */}
          <a className="secondary" href={api.exportUrl()} download>
            Download everything
          </a>
        </div>

        {/*
          * The key is a separate, deliberate act.
          *
          * The plain export is a health record — sensitive, and something you
          * might reasonably hand to a doctor. Adding the key makes it a
          * credential too: whoever holds it can read every future snapshot and
          * act as you on chain. Two different objects, two different buttons.
          */}
        <details className="trust-note">
          <summary>Take your key as well</summary>
          <p>
            Your records are also stored encrypted on 0G, and the copies there outlive this
            company. Reading them needs the key they are encrypted to — which we hold today,
            because signing in here is a phone number and nothing else.
          </p>
          <p>
            You can take a copy of that key. With it, the encrypted copies are yours to read
            forever, with none of this involved.
          </p>
          <p>
            <strong>It is also a credential.</strong> Anyone holding it can read your records
            and act as you on 0G Chain. Keep it the way you keep a bank password, and do not
            send that file to anyone.
          </p>
          <a className="secondary" href={api.exportWithKeyUrl()} download>
            Download with my key
          </a>
        </details>
      </section>

      {/* -------------------------------------------------------- account */}
      <section className="panel">
        <h2>Account</h2>
        {me?.user.phone && <p className="muted">Signed in as {me.user.phone}</p>}

        <button
          type="button"
          className="danger"
          onClick={() => void signOut()}
          disabled={busy === 'signout'}
        >
          {busy === 'signout' ? 'Signing out…' : 'Sign out'}
        </button>
      </section>

      {note && (
        <p className="turn-notice" role="status">
          {note}
        </p>
      )}
    </section>
  )
}
