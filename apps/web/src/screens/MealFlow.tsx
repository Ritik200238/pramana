/**
 * The meal flow. This screen is the product.
 *
 * Photo -> at most two questions -> a number with its confidence. Nothing here
 * ever shows a calorie figure the user did not have a chance to correct, and
 * the questions are the point rather than an interruption: a wrong number
 * delivered confidently is what destroys trust in every competing app.
 */

import { useCallback, useRef, useState } from 'react'
import {
  ApiError,
  api,
  enqueue,
  isBlocked,
  isNotFood,
  type Answer,
  type DraftResponse,
  type Question,
} from '../lib/api.ts'
import { Blocked } from '../components/Blocked.tsx'
import { ConfidenceBadge } from '../components/ConfidenceBadge.tsx'

type Stage =
  | { name: 'capture' }
  | { name: 'reading' }
  | {
      name: 'questions'
      draft: DraftResponse
      index: number
      answers: Answer[]
      source: 'photo' | 'text'
    }
  | { name: 'result'; kcal: number; proteinG: number; confidence: 'exact' | 'confirmed' | 'rough' }
  | { name: 'blocked'; message: string; helpline?: { label: string; number: string } }
  | { name: 'notfood'; message: string }
  | { name: 'error'; message: string }

export interface MealFlowProps {
  onClose: () => void
  onLogged: () => void
}

/**
 * Something worth showing a person.
 *
 * The server writes a better sentence than we can for what it knows about —
 * being rate limited, most often. Anything else gets a plain one rather than a
 * status line off the wire.
 */
function readableError(error: unknown): string {
  return (
    (error instanceof ApiError && error.userMessage) ||
    'That did not go through. Your photo is still here.'
  )
}

export function MealFlow({ onClose, onLogged }: MealFlowProps) {
  const [stage, setStage] = useState<Stage>({ name: 'capture' })
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * What was last sent to be read.
   *
   * Kept so that "try again" retries the request rather than the photograph.
   * Sending the user back to the camera after a failure means re-photographing
   * food they may already be eating, over something that was usually a dropped
   * connection — the plate has moved, the light has changed, and the failure
   * was never theirs.
   */
  const lastInput = useRef<{ kind: 'photo'; dataUrl: string } | { kind: 'text'; body: string } | null>(
    null,
  )

  const commit = useCallback(
    async (draft: DraftResponse, answers: Answer[], source: 'photo' | 'text' = 'photo') => {
      const body = {
        vision: draft.vision,
        answers,
        // Recorded accurately: a text log counted as a photo log would corrupt
        // the only data telling us which entry method people actually use.
        source,
        model: draft.model,
        failovers: draft.failovers,
      }

      try {
        const result = await api.commitMeal(body)
        setStage({
          name: 'result',
          kcal: Math.round(result.totals.kcal),
          proteinG: Math.round(result.totals.proteinG),
          confidence: result.confidence,
        })
      } catch {
        // Offline or the server is down. The meal is saved locally and
        // replayed later — the user is told it is safe, not asked to retry.
        enqueue('/meals/commit', body)
        setStage({
          name: 'result',
          kcal: Math.round(draft.estimate.kcal),
          proteinG: Math.round(draft.estimate.proteinG),
          confidence: 'rough',
        })
      }
    },
    [],
  )

  const onFile = useCallback(
    async (file: File) => {
      setStage({ name: 'reading' })
      try {
        const dataUrl = await toDataUrl(file)
        lastInput.current = { kind: 'photo', dataUrl }
        const result = await api.draftMeal(dataUrl)

        if (isBlocked(result)) {
          setStage({ name: 'blocked', message: result.message, ...(result.helpline ? { helpline: result.helpline } : {}) })
          return
        }
        if (isNotFood(result)) {
          setStage({ name: 'notfood', message: result.message })
          return
        }

        // No questions worth asking means this user has already settled
        // everything on the plate. Log it straight through.
        if (result.questions.length === 0) {
          await commit(result, [])
          return
        }

        setStage({ name: 'questions', draft: result, index: 0, answers: [], source: 'photo' })
      } catch (error) {
        setStage({ name: 'error', message: readableError(error) })
      }
    },
    [commit],
  )

  const onText = useCallback(
    async (description: string) => {
      setStage({ name: 'reading' })
      lastInput.current = { kind: 'text', body: description }
      try {
        const result = await api.draftMealText(description)

        if (isBlocked(result)) {
          setStage({
            name: 'blocked',
            message: result.message,
            ...(result.helpline ? { helpline: result.helpline } : {}),
          })
          return
        }
        if (isNotFood(result)) {
          setStage({ name: 'notfood', message: result.message })
          return
        }
        if (result.questions.length === 0) {
          await commit(result, [], 'text')
          return
        }
        setStage({ name: 'questions', draft: result, index: 0, answers: [], source: 'text' })
      } catch (error) {
        setStage({ name: 'error', message: readableError(error) })
      }
    },
    [commit],
  )

  /** Send the same thing again. The failure was almost never the picture. */
  const retry = useCallback(async () => {
    const input = lastInput.current
    if (!input) return
    if (input.kind === 'text') return onText(input.body)

    setStage({ name: 'reading' })
    try {
      const result = await api.draftMeal(input.dataUrl)
      if (isBlocked(result)) {
        setStage({
          name: 'blocked',
          message: result.message,
          ...(result.helpline ? { helpline: result.helpline } : {}),
        })
        return
      }
      if (isNotFood(result)) {
        setStage({ name: 'notfood', message: result.message })
        return
      }
      if (result.questions.length === 0) {
        await commit(result, [])
        return
      }
      setStage({ name: 'questions', draft: result, index: 0, answers: [], source: 'photo' })
    } catch (error) {
      setStage({ name: 'error', message: readableError(error) })
    }
  }, [commit, onText])

  const answer = useCallback(
    (question: Question, choice: string) => {
      setStage((current) => {
        if (current.name !== 'questions') return current

        const next: Answer = {
          itemId: question.itemId,
          kind: question.kind,
          answer: choice,
          ...parseChoice(question, choice),
        }
        const answers = [...current.answers, next]
        const index = current.index + 1

        if (index >= current.draft.questions.length) {
          void commit(current.draft, answers, current.source)
          return { name: 'reading' }
        }
        return { ...current, index, answers }
      })
    },
    [commit],
  )

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Log a meal">
      <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
        ✕
      </button>

      {stage.name === 'capture' && (
        <div className="stage stage-capture">
          <h2>What are you eating?</h2>
          <p className="muted">One photo. I will ask if I cannot tell how much.</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void onFile(file)
            }}
          />
          <button type="button" className="primary big" onClick={() => fileRef.current?.click()}>
            Take a photo
          </button>

          {/* Photos fail at restaurants, in bad light, and for anything already
              eaten. Someone who cannot log what they just finished stops logging. */}
          <form
            className="text-entry"
            onSubmit={(event) => {
              event.preventDefault()
              if (text.trim()) void onText(text.trim())
            }}
          >
            <input
              type="text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="or type it — 2 roti aur rajma"
              aria-label="Describe your meal"
              enterKeyHint="go"
            />
            <button type="submit" className="quiet" disabled={!text.trim()}>
              Log
            </button>
          </form>
        </div>
      )}

      {/*
        * Announced, because this is the longest wait in the product — a vision
        * model takes seconds — and a screen reader user was previously told
        * nothing at all between taking a photo and being asked a question.
        */}
      {stage.name === 'reading' && (
        <div className="stage" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Reading your plate…</p>
        </div>
      )}

      {stage.name === 'questions' && (
        <QuestionCard
          question={stage.draft.questions[stage.index]!}
          step={stage.index + 1}
          total={stage.draft.questions.length}
          onAnswer={answer}
        />
      )}

      {/* The payoff, announced for the same reason the wait is. */}
      {stage.name === 'result' && (
        <div className="stage stage-result" role="status" aria-live="polite">
          <div className="result-number">
            <strong>{stage.proteinG}g</strong>
            <span>protein</span>
          </div>
          <p className="result-kcal">{stage.kcal} kcal</p>
          <ConfidenceBadge level={stage.confidence} />
          <button type="button" className="primary" onClick={onLogged}>
            Done
          </button>
        </div>
      )}

      {stage.name === 'notfood' && (
        <div className="stage">
          <p>{stage.message}</p>
          <button type="button" className="primary" onClick={() => setStage({ name: 'capture' })}>
            Try again
          </button>
        </div>
      )}

      {stage.name === 'blocked' && (
        <Blocked message={stage.message} helpline={stage.helpline} onClose={onClose} />
      )}

      {stage.name === 'error' && (
        <div className="stage" role="status" aria-live="polite">
          <p>{stage.message}</p>

          {/* Retries what was sent, not the photograph. */}
          {lastInput.current && (
            <button type="button" className="primary" onClick={() => void retry()}>
              Try again
            </button>
          )}

          <button type="button" className="quiet" onClick={() => setStage({ name: 'capture' })}>
            Take another photo
          </button>
        </div>
      )}
    </div>
  )
}

interface QuestionCardProps {
  question: Question
  step: number
  total: number
  onAnswer: (question: Question, choice: string) => void
}

function QuestionCard({ question, step, total, onAnswer }: QuestionCardProps) {
  return (
    <div className="stage stage-question">
      {/* Shown so the end is always visible. Two questions with a visible
          endpoint reads as care; an open-ended interrogation reads as friction. */}
      <p className="step">
        {step} of {total}
      </p>
      <h2>{question.text}</h2>
      <div className="options">
        {question.options.map((option) => (
          <button
            key={option}
            type="button"
            className="option"
            onClick={() => onAnswer(question, option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Pull structured values out of the chosen option where we can. */
function parseChoice(question: Question, choice: string): Partial<Answer> {
  if (question.kind === 'portion') {
    const match = /(\d+(?:\.\d+)?)/.exec(choice)
    return match ? { units: Number.parseFloat(match[1]!) } : {}
  }

  if (question.kind === 'cooking_fat') {
    const lower = choice.toLowerCase()
    if (/plain|dry|no |without/.test(lower)) return { cookingFat: 'none', cookingFatTsp: 0 }
    if (lower.includes('ghee')) return { cookingFat: 'ghee', cookingFatTsp: /generous|lots/.test(lower) ? 2 : 1 }
    if (lower.includes('butter')) return { cookingFat: 'butter', cookingFatTsp: 1 }
    if (lower.includes('oil')) return { cookingFat: 'oil', cookingFatTsp: /generous|lots/.test(lower) ? 2 : 1 }
  }

  return {}
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that image.'))
    reader.readAsDataURL(file)
  })
}
