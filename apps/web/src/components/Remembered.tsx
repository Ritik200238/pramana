/**
 * What we remember, and the one control that closes a topic.
 *
 * R6 says the user talks and we listen and remember, always. Everything here was
 * already doing that work — a fact drives the coach's context, the weekly
 * review, the proactive nudge, the encrypted snapshot and the export — and none
 * of it was visible. A person had to take on trust both what we kept and that
 * we would stop bringing it up.
 *
 * The schema is blunt about why resolving exists: "a resolved fact is NEVER
 * raised again by the proactive engine — this column exists because of a
 * documented harm: a coach that kept surfacing a healed injury for three months
 * and then argued with the user about it." That control shipped with no way to
 * reach it, which meant the harm it prevents was unprevented.
 *
 * Two decisions worth naming.
 *
 * Their words, verbatim, never our summary. Showing somebody a paraphrase of
 * what they said and presenting it as what they said is a small betrayal, and on
 * a screen about being remembered accurately it is the whole subject.
 *
 * And resolving says "sorted", not "delete". Nothing is thrown away — R6 again —
 * it stops being raised. Offering a delete we do not perform would be worse than
 * offering nothing.
 */

import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type RememberedFact } from '../lib/api.ts'

/** Plain words for a kind. Nobody thinks in enum values. */
const KIND_LABEL: Record<string, string> = {
  sleep: 'Sleep',
  workout: 'Training',
  mood: 'Mood',
  symptom: 'Something bothering you',
  energy: 'Energy',
  weight: 'Weight',
}

export function Remembered() {
  const [facts, setFacts] = useState<RememberedFact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.facts()
      setFacts(result.facts)
      setError(null)
    } catch (caught) {
      setError(
        (caught instanceof ApiError ? caught.userMessage : null) ??
          'Could not load this just now.',
      )
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const resolve = async (fact: RememberedFact) => {
    setClosing(fact.id)
    try {
      await api.resolveFact(fact.id)
      // Removed here rather than refetched: they just told us it is finished,
      // and showing it again for a moment while a request lands reads as though
      // we did not listen.
      setFacts((current) => (current ?? []).filter((item) => item.id !== fact.id))
    } catch {
      setError('That did not save. Try again in a moment.')
    } finally {
      setClosing(null)
    }
  }

  if (error !== null && facts === null) {
    return (
      <section className="panel">
        <h2>What I remember</h2>
        <p className="error">{error}</p>
        <button type="button" className="quiet" onClick={() => void load()}>
          Try again
        </button>
      </section>
    )
  }

  if (facts === null) {
    return (
      <section className="panel">
        <h2>What I remember</h2>
        <p className="muted">Checking…</p>
      </section>
    )
  }

  return (
    <section className="panel remembered">
      <h2>What I remember</h2>

      {facts.length === 0 ? (
        <p className="muted">
          Nothing open right now. Anything you mention in chat — sleep, a niggle,
          a bad week — is kept here.
        </p>
      ) : (
        <>
          <p className="muted">
            In your words. Say when something is sorted and I will stop bringing it up.
          </p>

          <ul className="fact-list">
            {facts.map((fact) => (
              <li key={fact.id} className="fact">
                <span className="fact-kind">{KIND_LABEL[fact.kind] ?? fact.kind}</span>
                <p className="fact-verbatim">“{fact.verbatim}”</p>
                <span className="fact-when">
                  {new Date(fact.occurredAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  className="quiet"
                  disabled={closing === fact.id}
                  onClick={() => void resolve(fact)}
                >
                  {closing === fact.id ? 'Closing…' : 'This is sorted'}
                </button>
              </li>
            ))}
          </ul>

          {/* Says what resolving does, because "sorted" could reasonably be read
              as "forget this" and it is not that. */}
          <p className="muted">
            Nothing is deleted. It stays in your record and stops being raised.
          </p>
        </>
      )}

      {error !== null && <p className="error">{error}</p>}
    </section>
  )
}
