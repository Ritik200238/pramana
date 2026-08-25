/**
 * R3, on screen.
 *
 * The commercial reason this exists rather than the aesthetic one: people
 * forgive a manual tracker for being wrong and do not forgive an AI for it. A
 * number that admits what it does not know survives being wrong; a confident
 * one does not.
 *
 * So a barcode must never look like a guess, and a guess must never look like
 * a barcode.
 */

export type Confidence = 'exact' | 'confirmed' | 'rough'

const COPY: Readonly<Record<Confidence, { dot: string; label: string; explain: string }>> = {
  exact: {
    dot: '🟢',
    label: 'Exact',
    explain: 'From a barcode or packet label.',
  },
  confirmed: {
    dot: '🟡',
    label: 'Confirmed',
    explain: 'You told me the amounts that mattered.',
  },
  rough: {
    dot: '🔴',
    label: 'Rough',
    explain: 'I estimated some of this.',
  },
}

/**
 * What to do about a rough number, which depends on where you are standing.
 *
 * The explanation used to end with "Tap any item to correct it" everywhere. On
 * the day view that is true — the meals are listed right underneath and each one
 * opens a correction. On the screen straight after logging it is not: that
 * screen shows a total, a badge and a Done button, and nothing on it can be
 * tapped.
 *
 * So the app told people to do something impossible at the exact moment they
 * were most likely to want it, having just been told the number was a guess.
 */
const ACTION: Readonly<Record<'here' | 'later', string>> = {
  here: ' Tap any item to correct it.',
  later: ' You can correct it once it is logged.',
}

export interface ConfidenceBadgeProps {
  level: Confidence
  /** Compact form for lists; the full form carries the explanation. */
  compact?: boolean
  /**
   * Whether this screen has something to tap. Defaults to false, so a new
   * placement has to claim the affordance rather than inherit a promise it may
   * not keep — which is how the wrong copy got onto the result screen.
   */
  correctable?: boolean
}

export function ConfidenceBadge({ level, compact, correctable = false }: ConfidenceBadgeProps) {
  const base = COPY[level]
  const copy =
    level === 'rough'
      ? { ...base, explain: base.explain + (correctable ? ACTION.here : ACTION.later) }
      : base

  if (compact) {
    return (
      <span className={`badge badge-${level}`} title={copy.explain}>
        <span aria-hidden="true">{copy.dot}</span>
        <span className="sr-only">{`${copy.label}. ${copy.explain}`}</span>
      </span>
    )
  }

  return (
    <div className={`confidence confidence-${level}`}>
      <span className="confidence-head">
        <span aria-hidden="true">{copy.dot}</span> {copy.label}
      </span>
      <span className="confidence-explain">{copy.explain}</span>
    </div>
  )
}
