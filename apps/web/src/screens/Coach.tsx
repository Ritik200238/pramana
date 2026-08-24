/**
 * The coach tab — features 10, 11, 12, 14.
 *
 * Four things a person actually asks, and nothing else:
 *   "what should I eat now"   -> from what is in front of them
 *   "how was today"           -> one line, one change
 *   "how was the week"        -> three sentences, one adjustment
 *   "why was I tired?"        -> answered from their own log
 *
 * No charts. The complaint this screen exists to answer was said almost
 * word-for-word in three separate subreddits: "once the data is there, it
 * mostly stops at charts", "tons of metrics, zero actual coaching".
 */

import { useCallback, useEffect, useState } from 'react'
import { api, isBlocked, type StreakState } from '../lib/api.ts'
import { Blocked } from '../components/Blocked.tsx'

type Panel = 'eat' | 'today' | 'week' | 'ask'

export interface CoachProps {
  userId: string
}

export function Coach({ userId }: CoachProps) {
  const [panel, setPanel] = useState<Panel>('eat')
  const [streak, setStreak] = useState<StreakState | null>(null)
  const [blocked, setBlocked] = useState<{ message: string; helpline?: { label: string; number: string } } | null>(null)

  useEffect(() => {
    api
      .streak(userId)
      .then(setStreak)
      .catch(() => {
        // A missing streak is not worth an error state.
      })
  }, [userId])

  if (blocked) {
    return (
      <Blocked
        message={blocked.message}
        helpline={blocked.helpline}
        onClose={() => setBlocked(null)}
      />
    )
  }

  return (
    <section className="coach">
      {streak && streak.currentDays > 0 && (
        <div className="streak" role="status">
          <strong>{streak.currentDays}</strong>
          <span>day{streak.currentDays === 1 ? '' : 's'} in a row</span>
          {/* Freezes are shown as available, never as "you used one". Announcing
              a kindness turns it into an accusation. */}
          {streak.freezesAvailable > 0 && (
            <em>{streak.freezesAvailable} rest day{streak.freezesAvailable === 1 ? '' : 's'} banked</em>
          )}
        </div>
      )}

      <nav className="panel-tabs" aria-label="Coach sections">
        {(
          [
            ['eat', 'Eat now'],
            ['today', 'Today'],
            ['week', 'This week'],
            ['ask', 'Ask'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={panel === key ? 'panel-tab panel-tab-on' : 'panel-tab'}
            onClick={() => setPanel(key)}
            aria-current={panel === key ? 'true' : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      {panel === 'eat' && <EatNow userId={userId} onBlocked={setBlocked} />}
      {panel === 'today' && <DayLine userId={userId} />}
      {panel === 'week' && <WeekReview userId={userId} />}
      {panel === 'ask' && <AskData userId={userId} onBlocked={setBlocked} />}
    </section>
  )
}

// ------------------------------------------------------------------ eat now

interface BlockHandler {
  onBlocked: (value: { message: string; helpline?: { label: string; number: string } }) => void
}

function EatNow({ userId, onBlocked }: { userId: string } & BlockHandler) {
  const [available, setAvailable] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [proteinLeft, setProteinLeft] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ask = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.suggest(userId, available.trim() || undefined)
      if (isBlocked(result)) {
        onBlocked({ message: result.message, ...(result.helpline ? { helpline: result.helpline } : {}) })
        return
      }
      setAnswer(result.suggestion)
      setProteinLeft(result.proteinLeftG)
    } catch {
      setError('Could not reach the coach. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }, [userId, available, onBlocked])

  return (
    <div className="panel">
      <h2>What should I eat?</h2>
      {proteinLeft !== null && (
        <p className="muted">{proteinLeft}g protein still to go today.</p>
      )}

      <label className="field-block">
        <span>What have you got? (optional)</span>
        <textarea
          value={available}
          onChange={(event) => setAvailable(event.target.value)}
          placeholder="dal, rice, curd, 2 eggs — or the mess menu"
          rows={3}
        />
      </label>

      <button type="button" className="primary" onClick={() => void ask()} disabled={busy}>
        {busy ? 'Thinking…' : 'Tell me'}
      </button>

      {answer && <div className="answer">{answer}</div>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- day line

function DayLine({ userId }: { userId: string }) {
  const [line, setLine] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .dayLine(userId)
      .then((result) => setLine(result.line))
      .catch(() => setError('Could not load today.'))
      .finally(() => setBusy(false))
  }, [userId])

  return (
    <div className="panel">
      <h2>Today</h2>
      {busy && <p className="muted">Looking at your day…</p>}
      {line && <div className="answer">{line}</div>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// ------------------------------------------------------------ week review

function WeekReview({ userId }: { userId: string }) {
  const [review, setReview] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    api
      .weekly(userId)
      .then((result) => {
        setReview(result.review)
        setMessage(result.message ?? null)
      })
      .catch(() => setMessage('Could not load this week.'))
      .finally(() => setBusy(false))
  }, [userId])

  return (
    <div className="panel">
      <h2>This week</h2>
      {busy && <p className="muted">Adding it up…</p>}
      {review && <div className="answer">{review}</div>}
      {/* Not enough data is a normal state, not a failure. Inventing a review
          from two data points would be worse than saying so. */}
      {!review && message && <p className="muted">{message}</p>}
    </div>
  )
}

// -------------------------------------------------------------- ask my data

function AskData({ userId, onBlocked }: { userId: string } & BlockHandler) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(async () => {
    const text = question.trim()
    if (!text) return

    setBusy(true)
    setAnswer(null)
    setNotice(null)
    try {
      const result = await api.ask(userId, text)
      if (isBlocked(result)) {
        onBlocked({ message: result.message, ...(result.helpline ? { helpline: result.helpline } : {}) })
        return
      }
      setAnswer(result.answer)
      setNotice(result.notice ?? null)
    } catch {
      setAnswer('Could not reach your records just now.')
    } finally {
      setBusy(false)
    }
  }, [userId, question, onBlocked])

  return (
    <div className="panel">
      <h2>Ask your own data</h2>
      <p className="muted">Answered from what you have logged, with the numbers shown.</p>

      <form
        className="ask-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="why have I been tired this week?"
          aria-label="Question about your data"
          enterKeyHint="send"
        />
        <button type="submit" className="primary" disabled={!question.trim() || busy}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>

      <div className="suggested-questions">
        {[
          'why have I been tired this week?',
          'am I hitting my protein?',
          'what changed since last week?',
        ].map((example) => (
          <button
            key={example}
            type="button"
            className="chip-button"
            onClick={() => setQuestion(example)}
          >
            {example}
          </button>
        ))}
      </div>

      {answer && <div className="answer">{answer}</div>}
      {notice && (
        <p className="turn-notice" role="note">
          {notice}
        </p>
      )}
    </div>
  )
}
