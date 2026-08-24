/**
 * Correcting one item of a logged meal.
 *
 * This is the moat's only entry point. A correction is what turns a dish from
 * the global database into *their* version of it — the portion they actually
 * serve, the fat they actually cook in — and every later log of that dish gets
 * it right without asking. The endpoint has existed the whole time with nothing
 * able to call it, partly because the day summary did not return item ids, so
 * the write path was unreachable from the read path.
 *
 * The interaction is deliberately small. Somebody correcting a portion is
 * mildly annoyed already; a form with six fields makes that worse, and a
 * correction that takes longer than the original log is one nobody makes twice.
 */

import { useCallback, useState } from 'react'
import { api } from '../lib/api.ts'

export interface CorrectItemProps {
  mealId: string
  item: {
    id: string
    name: string
    units: number
    portionLabel: string
    kcal: number
    proteinG: number
  }
  onClose: () => void
  onSaved: () => void
}

const FATS = [
  { value: 'none', label: 'No oil' },
  { value: 'oil', label: 'Oil' },
  { value: 'ghee', label: 'Ghee' },
  { value: 'butter', label: 'Butter' },
] as const

export function CorrectItem({ mealId, item, onClose, onSaved }: CorrectItemProps) {
  const [units, setUnits] = useState(item.units)
  const [fat, setFat] = useState<string | null>(null)
  const [fatTsp, setFatTsp] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.correctItem(mealId, item.id, {
        ...(units !== item.units ? { units } : {}),
        ...(fat ? { cookingFat: fat, cookingFatTsp: fatTsp } : {}),
      })

      // `learned` is the part worth knowing: this dish is now theirs, and the
      // next log of it will not ask.
      if (result.learned) onSaved()
      else onSaved()
    } catch {
      setError('Could not save that. It stays as it was.')
    } finally {
      setBusy(false)
    }
  }, [mealId, item.id, item.units, units, fat, fatTsp, onSaved])

  const changed = units !== item.units || fat !== null

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={`Correct ${item.name}`}>
      <div className="stage">
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <h2>{item.name}</h2>
        <p className="muted">
          {item.portionLabel} · {Math.round(item.kcal)} kcal · {Math.round(item.proteinG)}g protein
        </p>

        <label className="field-block">
          <span>How many did you actually have?</span>
          <div className="stepper">
            <button
              type="button"
              onClick={() => setUnits((value) => Math.max(0.5, Math.round((value - 0.5) * 2) / 2))}
              aria-label="Less"
            >
              −
            </button>
            <strong aria-live="polite">{units}</strong>
            <button
              type="button"
              onClick={() => setUnits((value) => Math.round((value + 0.5) * 2) / 2)}
              aria-label="More"
            >
              +
            </button>
          </div>
        </label>

        {/* Cooking fat is a property of the dish, not a note on it. Roti with
            ghee and roti without differ by more than most people's deficit. */}
        <div className="field-block">
          <span>Cooked in?</span>
          <div className="options options-row">
            {FATS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={fat === option.value ? 'option option-on' : 'option'}
                onClick={() => setFat(option.value)}
                aria-pressed={fat === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {fat && fat !== 'none' && (
          <label className="field-block">
            <span>How many teaspoons?</span>
            <div className="stepper">
              <button
                type="button"
                onClick={() => setFatTsp((value) => Math.max(0, value - 1))}
                aria-label="Less"
              >
                −
              </button>
              <strong aria-live="polite">{fatTsp}</strong>
              <button type="button" onClick={() => setFatTsp((value) => value + 1)} aria-label="More">
                +
              </button>
            </div>
          </label>
        )}

        <button
          type="button"
          className="primary big"
          onClick={() => void save()}
          disabled={!changed || busy}
        >
          {busy ? 'Saving…' : 'Save — and remember this'}
        </button>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
