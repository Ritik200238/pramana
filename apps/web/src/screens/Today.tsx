/**
 * Today.
 *
 * Protein is the hero number and calories sit underneath it. That inversion is
 * deliberate: "am I getting enough protein" is a question Indian users are
 * already asking themselves, and it gives the app one job a person can name in
 * a sentence. A calorie ring is a dashboard, and dashboards are what people
 * stop opening.
 *
 * There is no score anywhere on this screen, and there will not be one. A
 * composite number with no published weighting cannot be argued with, which is
 * exactly why people stop looking at it.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, type DaySummary, type ProactiveMessage, type Usual } from '../lib/api.ts'
import { ConfidenceBadge } from '../components/ConfidenceBadge.tsx'

export interface TodayProps {
  onCapture: () => void
  onOpenChat: () => void
}

export function Today({ onCapture, onOpenChat }: TodayProps) {
  const [day, setDay] = useState<DaySummary | null>(null)
  const [usuals, setUsuals] = useState<Usual[]>([])
  const [nudge, setNudge] = useState<ProactiveMessage | null>(null)
  const [repeating, setRepeating] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)

  const load = useCallback(async () => {
    try {
      const [summary, usualsResult] = await Promise.all([api.today(), api.usuals()])
      setDay(summary)
      setUsuals(usualsResult.usuals)
      setOffline(false)
    } catch {
      // Offline is not an error state. We show what we have and say so quietly.
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // Silence is this feature's normal state — it returns null almost always.
    api
      .proactive()
      .then((result) => setNudge(result.message))
      .catch(() => {
        // Never surface a failure here. An unasked question costs nothing.
      })
  }, [])

  const repeat = useCallback(
    async (usual: Usual) => {
      setRepeating(usual.sourceMealId)
      try {
        await api.repeatMeal(usual.sourceMealId)
        await load()
      } catch {
        setOffline(true)
      } finally {
        setRepeating(null)
      }
    },
    [load],
  )

  const targets = day?.targets
  const proteinLeft = day?.proteinLeftG ?? 0
  const proteinPct = day?.proteinPct ?? 0

  return (
    <section className="today">
      {nudge && (
        <button type="button" className="nudge" onClick={onOpenChat}>
          <span className="nudge-text">{nudge.text}</span>
          <span className="nudge-go">Reply →</span>
        </button>
      )}

      <p className="eyebrow">Today</p>

      <div className="hero">
        <div
          className="ring"
          style={{ ['--pct' as string]: `${proteinPct}` }}
          role="img"
          aria-label={
            targets
              ? `${Math.round(day?.totals.proteinG ?? 0)} of ${targets.proteinG} grams of protein`
              : 'Protein target not set'
          }
        >
          <div className="ring-inner">
            <strong>{proteinLeft}g</strong>
            <span>protein left</span>
          </div>
        </div>
      </div>

      <dl className="stats">
        <div>
          <dt>Protein</dt>
          <dd>
            {Math.round(day?.totals.proteinG ?? 0)}
            {targets ? ` / ${targets.proteinG}` : ''} g
          </dd>
        </div>
        <div>
          <dt>Calories</dt>
          <dd>
            {Math.round(day?.totals.kcal ?? 0)}
            {targets ? ` / ${targets.calories}` : ''}
          </dd>
        </div>
        <div>
          <dt>Meals</dt>
          <dd>{day?.mealCount ?? 0}</dd>
        </div>
      </dl>

      {day && day.mealCount > 0 && (
        <div className="day-confidence">
          <ConfidenceBadge level={day.confidence} />
        </div>
      )}

      {/* R4's payoff. A meal eaten before is one tap and zero questions. */}
      {usuals.length > 0 && (
        <section className="usuals">
          <h2>Your usual</h2>
          <div className="usual-list">
            {usuals.map((usual) => (
              <button
                key={usual.sourceMealId}
                type="button"
                className="usual"
                onClick={() => void repeat(usual)}
                disabled={repeating !== null}
              >
                <span className="usual-label">{usual.label}</span>
                <span className="usual-meta">
                  {Math.round(usual.proteinG)}g protein · {Math.round(usual.kcal)} kcal
                </span>
                <span className="usual-action">
                  {repeating === usual.sourceMealId ? 'Logging…' : 'Log again'}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {day && day.meals.length > 0 && (
        <section className="meal-list">
          <h2>Logged today</h2>
          {day.meals.map((meal) => (
            <div key={meal.id} className="meal-row">
              <div className="meal-row-main">
                <span className="meal-row-name">
                  {meal.items.map((item) => item.name).join(', ') || 'Meal'}
                </span>
                <span className="meal-row-time">
                  {new Date(meal.eatenAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="meal-row-side">
                <span className="meal-row-protein">{Math.round(meal.proteinG)}g</span>
                <ConfidenceBadge level={meal.confidence} compact />
              </div>
            </div>
          ))}
        </section>
      )}

      {targets && targets.safetyNotes.length > 0 && (
        <div className="notes" role="note">
          {/* Clamping is always disclosed. Quietly lowering someone's requested
              pace without saying so is how an app loses the right to be trusted. */}
          {targets.safetyNotes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}

      {day && day.mealCount === 0 && usuals.length === 0 && (
        <div className="empty">
          <p>Nothing logged yet today.</p>
          <button type="button" className="primary" onClick={onCapture}>
            Log your first meal
          </button>
        </div>
      )}

      {offline && (
        <p className="offline-note">Showing what I have — you look offline.</p>
      )}
    </section>
  )
}
