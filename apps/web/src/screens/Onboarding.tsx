/**
 * Onboarding.
 *
 * Target is under ninety seconds to a first real number. Five steps, one tap
 * each where possible, and no account until after they have seen something
 * personal — asking for an email before delivering value is the "fake free
 * trial" pattern users describe as predatory, and it is the top 1-star theme
 * for every competitor.
 *
 * The fourth question — who cooks — is asked by nobody else and drives most of
 * the later personalisation. A hostel mess and a home kitchen are different
 * products wearing the same interface.
 */

import { useState } from 'react'
import { api, isBlocked, type Targets } from '../lib/api.ts'
import { Blocked } from '../components/Blocked.tsx'

export interface OnboardingProps {
  /**
   * Identity is not passed here. It came from sign-in and lives in the session,
   * so onboarding only reports the numbers it produced.
   */
  onDone: (targets: Targets) => void
}

type Goal = 'lose' | 'gain' | 'maintain' | 'recomp'
type Diet = 'veg' | 'nonveg' | 'egg' | 'vegan' | 'jain'
type Cooks = 'self' | 'family' | 'mess' | 'tiffin' | 'mixed'
type Activity = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active'

export function Onboarding({ onDone }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const [goal, setGoal] = useState<Goal>('lose')
  const [sex, setSex] = useState<'male' | 'female'>('male')
  const [ageYears, setAge] = useState(25)
  const [heightCm, setHeight] = useState(170)
  const [weightKg, setWeight] = useState(70)
  const [activity, setActivity] = useState<Activity>('light')
  const [diet, setDiet] = useState<Diet>('veg')
  const [cooks, setCooks] = useState<Cooks>('self')
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState<{ message: string; helpline?: { label: string; number: string } } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.createProfile({
        sex,
        ageYears,
        heightCm,
        weightKg,
        activity,
        goal,
        diet,
        cooks,
      })

      if (isBlocked(result)) {
        setBlocked({ message: result.message, ...(result.helpline ? { helpline: result.helpline } : {}) })
        return
      }

      onDone(result.targets)
    } catch {
      setError('Could not save that. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (blocked) {
    return <Blocked message={blocked.message} helpline={blocked.helpline} onClose={() => setBlocked(null)} />
  }

  return (
    <div className="onboarding">
      <header className="onboard-head">
        <h1>It asks. It doesn&rsquo;t guess.</h1>
        <p className="muted">Five quick things, then you can log your first meal.</p>
      </header>

      <div className="progress" aria-hidden="true">
        <span style={{ width: `${((step + 1) / 5) * 100}%` }} />
      </div>

      {step === 0 && (
        <Choice
          title="What are you after?"
          options={[
            ['lose', 'Lose weight'],
            ['gain', 'Gain weight'],
            ['maintain', 'Maintain'],
            ['recomp', 'Get leaner, same weight'],
          ]}
          value={goal}
          onPick={(value) => {
            setGoal(value as Goal)
            setStep(1)
          }}
        />
      )}

      {step === 1 && (
        <div className="stage">
          <h2>The basics</h2>
          <div className="fields">
            <Choice
              inline
              title="Sex"
              options={[
                ['male', 'Male'],
                ['female', 'Female'],
              ]}
              value={sex}
              onPick={(value) => setSex(value as 'male' | 'female')}
            />
            <Field label="Age" value={ageYears} min={18} max={100} onChange={setAge} suffix="years" />
            <Field label="Height" value={heightCm} min={120} max={220} onChange={setHeight} suffix="cm" />
            <Field label="Weight" value={weightKg} min={30} max={250} onChange={setWeight} suffix="kg" />
          </div>
          <button type="button" className="primary" onClick={() => setStep(2)}>
            Next
          </button>
        </div>
      )}

      {step === 2 && (
        <Choice
          title="How much do you move?"
          options={[
            ['sedentary', 'Mostly sitting'],
            ['light', 'A bit of walking'],
            ['moderate', 'Exercise 3–4 days'],
            ['active', 'Exercise most days'],
            ['very_active', 'Hard training daily'],
          ]}
          value={activity}
          onPick={(value) => {
            setActivity(value as Activity)
            setStep(3)
          }}
        />
      )}

      {step === 3 && (
        <Choice
          title="What do you eat?"
          options={[
            ['veg', 'Vegetarian'],
            ['egg', 'Egg is fine'],
            ['nonveg', 'Non-vegetarian'],
            ['vegan', 'Vegan'],
            ['jain', 'Jain'],
          ]}
          value={diet}
          onPick={(value) => {
            setDiet(value as Diet)
            setStep(4)
          }}
        />
      )}

      {step === 4 && (
        <Choice
          title="Who cooks your food?"
          hint="This changes what I can suggest, so it is worth a tap."
          options={[
            ['self', 'I cook'],
            ['family', 'Family cooks'],
            ['mess', 'Hostel or mess'],
            ['tiffin', 'Tiffin service'],
            ['mixed', 'Bit of everything'],
          ]}
          value={cooks}
          onPick={(value) => {
            setCooks(value as Cooks)
            void submit()
          }}
          busy={busy}
        />
      )}

      {error && <p className="error">{error}</p>}
    </div>
  )
}

interface ChoiceProps {
  title: string
  hint?: string
  options: ReadonlyArray<readonly [string, string]>
  value: string
  onPick: (value: string) => void
  inline?: boolean
  busy?: boolean
}

function Choice({ title, hint, options, value, onPick, inline, busy }: ChoiceProps) {
  return (
    <div className={inline ? 'choice choice-inline' : 'stage choice'}>
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      <div className="options">
        {options.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={value === key ? 'option option-on' : 'option'}
            onClick={() => onPick(key)}
            disabled={busy}
          >
            {label}
          </button>
        ))}
      </div>
      {busy && <p className="muted">Working out your numbers…</p>}
    </div>
  )
}

interface FieldProps {
  label: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (value: number) => void
}

function Field({ label, value, min, max, suffix, onChange }: FieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <em>{suffix}</em>
    </label>
  )
}
