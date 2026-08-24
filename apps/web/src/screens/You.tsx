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
