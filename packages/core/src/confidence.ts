/**
 * R3 — every number carries its confidence, visibly.
 *
 * The commercial reason this exists, not the aesthetic one: users forgive a
 * manual tracker for being wrong and do not forgive an AI for it. A confident
 * wrong number destroys trust in a way an admitted estimate does not. So a
 * barcode must never look like a guess, and a guess must never look like a
 * barcode.
 */

export type Confidence = 'exact' | 'confirmed' | 'rough'

export interface ConfidenceInput {
  /** Came from a barcode or a packet label. */
  fromBarcode: boolean
  /** Every unknown above the impact threshold was answered by the user. */
  allSignificantAnswered: boolean
  /** Lowest per-item model confidence contributing to this total. */
  minItemConfidence: number
}

/** Below this, a model-estimated item is not trustworthy enough to call confirmed. */
export const ROUGH_CONFIDENCE_CEILING = 0.6

export function classify(input: ConfidenceInput): Confidence {
  if (input.fromBarcode) return 'exact'
  if (input.allSignificantAnswered && input.minItemConfidence >= ROUGH_CONFIDENCE_CEILING) {
    return 'confirmed'
  }
  return 'rough'
}

/** A whole day is only as good as its weakest entry. */
export function rollUp(entries: readonly Confidence[]): Confidence {
  if (entries.length === 0) return 'rough'
  if (entries.includes('rough')) return 'rough'
  if (entries.includes('confirmed')) return 'confirmed'
  return 'exact'
}

export const LABEL: Readonly<Record<Confidence, { badge: string; short: string; explain: string }>> =
  {
    exact: {
      badge: '🟢',
      short: 'Exact',
      explain: 'From a barcode or packet label.',
    },
    confirmed: {
      badge: '🟡',
      short: 'Confirmed',
      explain: 'You told us the amounts that mattered.',
    },
    rough: {
      badge: '🔴',
      short: 'Rough',
      explain: 'We estimated some of this. Tap any item to correct it.',
    },
  }
