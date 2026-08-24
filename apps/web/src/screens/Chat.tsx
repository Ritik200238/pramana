/**
 * The life chat — feature 02, rule R6.
 *
 * One thread, not per-topic channels. Life is not foldered, and asking someone
 * to pick a category before they can say "stomach's been off for three days" is
 * how you stop them telling you anything.
 *
 * What was understood is shown quietly beneath the reply, tappable to correct.
 * Never a confirmation dialog: the fastest way to make talking feel like filing
 * a form is to acknowledge every sentence.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isBlocked, type ChatResponse } from '../lib/api.ts'
import { Blocked } from '../components/Blocked.tsx'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  understood?: ChatResponse['understood']
  notice?: string
  /** Started by the coach rather than the user. Marked so it reads as such. */
  proactive?: boolean
}

export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [blocked, setBlocked] = useState<{ message: string; helpline?: { label: string; number: string } } | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .history()
      .then((data) => {
        setTurns(
          data.messages.map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: message.content,
          })),
        )
      })
      .catch(() => {
        // Offline. An empty thread is better than an error screen.
      })
  }, [])

  // A proactive message the user has not seen yet.
  //
  // Without this the engine could ask a question and record it as asked, while
  // the person never saw it — burning the one message a day on nobody, and
  // making a follow-up look like it was ignored.
  useEffect(() => {
    api
      .proactive()
      .then((result) => {
        if (!result.message) return
        setTurns((current) => {
          // The history fetch may already have it; do not show it twice.
          const last = current.at(-1)
          if (last?.role === 'assistant' && last.content === result.message?.text) return current
          return [...current, { role: 'assistant', content: result.message!.text, proactive: true }]
        })
      })
      .catch(() => {
        // An unasked question costs nothing. Never surface a failure here.
      })
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns])

  const send = useCallback(async () => {
    const message = draft.trim()
    if (!message || sending) return

    setDraft('')
    setSending(true)
    setTurns((current) => [...current, { role: 'user', content: message }])

    try {
      const response = await api.chat(message)

      if (isBlocked(response)) {
        setBlocked({ message: response.message, ...(response.helpline ? { helpline: response.helpline } : {}) })
        setTurns((current) => [...current, { role: 'assistant', content: response.message }])
        return
      }

      setTurns((current) => [
        ...current,
        {
          role: 'assistant',
          content: response.reply,
          understood: response.understood,
          ...(response.notice ? { notice: response.notice } : {}),
        },
      ])
    } catch {
      setTurns((current) => [
        ...current,
        {
          role: 'assistant',
          content: "I couldn't reach the server just now. What you wrote is still here.",
        },
      ])
    } finally {
      setSending(false)
    }
  }, [draft, sending])

  if (blocked) {
    return <Blocked message={blocked.message} helpline={blocked.helpline} onClose={() => setBlocked(null)} />
  }

  return (
    <section className="chat">
      {/*
        * Announced politely, so a reply reaches somebody using a screen reader
        * at all. Without this the coach answers into silence: the text arrives
        * on screen and nothing tells them it did.
        *
        * `polite` rather than `assertive` — an answer is worth hearing at the
        * next pause, not worth cutting them off mid-sentence.
        */}
      <div className="thread" aria-live="polite" aria-atomic="false">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p>Tell me anything — how you slept, what you did, how you feel.</p>
            <p className="muted">You do not have to. I am just here.</p>
          </div>
        )}

        {turns.map((turn, index) => (
          <div
            key={index}
            className={`turn turn-${turn.role}${turn.proactive ? ' turn-proactive' : ''}`}
          >
            {turn.proactive && <span className="turn-tag">Checking in</span>}
            <p>{turn.content}</p>

            {turn.notice && (
              <p className="turn-notice" role="note">
                {turn.notice}
              </p>
            )}

            {turn.understood && turn.understood.length > 0 && (
              <ul className="understood" aria-label="What I noted">
                {turn.understood.map((fact, factIndex) => (
                  <li key={factIndex}>
                    <span className="fact-kind">{fact.kind}</span>
                    <span className="fact-text">{fact.verbatim}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {sending && <div className="turn turn-assistant typing">…</div>}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="slept badly, gym felt hard…"
          aria-label="Message"
          enterKeyHint="send"
        />
        <button type="submit" className="send" disabled={!draft.trim() || sending}>
          Send
        </button>
      </form>
    </section>
  )
}
