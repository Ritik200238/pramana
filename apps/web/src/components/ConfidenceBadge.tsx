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
    explain: 'I estimated some of this. Tap any item to correct it.',
  },
}

export interface ConfidenceBadgeProps {
  level: Confidence
  /** Compact form for lists; the full form carries the explanation. */
  compact?: boolean
}

export function ConfidenceBadge({ level, compact }: ConfidenceBadgeProps) {
  const copy = COPY[level]

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
