/**
 * Whether the text can actually be read.
 *
 * The axe sweep covers structure — names, roles, labels — and explicitly does
 * not cover contrast, because jsdom has no layout to measure. That left the one
 * accessibility property a person notices immediately unchecked, and it was
 * failing.
 *
 * Contrast lives in the tokens rather than in the DOM, so it can be computed
 * exactly from the palette with the WCAG formula. No browser required, no
 * approximation: the same arithmetic a browser extension would do.
 *
 * `--ink-3` was #6f6d68, which is 3.45:1 on the page background and 2.80:1 on a
 * raised surface — below the 4.5:1 small text needs, and the second below even
 * the 3:1 that large text is allowed. It is used at 10 to 13 pixels on the
 * labels above the numbers on the home screen and on the "1 of 2" in the
 * question flow. Read on a phone, frequently outdoors.
 */

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(import.meta.dirname, '..', 'src', 'app.css'), 'utf8')

/** The palette, read from the stylesheet rather than repeated here. */
function tokens(): Record<string, string> {
  const found: Record<string, string> = {}
  for (const [, name, value] of CSS.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    found[name!] = value!
  }
  return found
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  )
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter! + 0.05) / (darker! + 0.05)
}

/** Every surface a given text colour is actually painted on. */
const SURFACES = ['bg', 'surface', 'surface-2']

describe('the text can be read', () => {
  test('the palette is found, so this is not checking nothing', () => {
    const palette = tokens()
    expect(Object.keys(palette).length).toBeGreaterThan(8)
    for (const surface of SURFACES) expect(palette[surface]).toBeTruthy()
  })

  test('every text colour clears AA on every surface it sits on', () => {
    const palette = tokens()

    /*
     * All three ink levels are used at 10 to 13 pixels somewhere — `.eyebrow`,
     * `.stats dt`, `.step` — so all three are small text and none of them get
     * the 3:1 large-text allowance.
     */
    const failures: string[] = []

    for (const ink of ['ink', 'ink-2', 'ink-3']) {
      for (const surface of SURFACES) {
        const ratio = contrast(palette[ink]!, palette[surface]!)
        if (ratio < 4.5) {
          failures.push(`--${ink} on --${surface}: ${ratio.toFixed(2)}:1, needs 4.5`)
        }
      }
    }

    expect(failures).toEqual([])
  })

  test('a status colour is distinguishable, not just coloured', () => {
    const palette = tokens()
    const failures: string[] = []

    /*
     * Somebody who cannot separate red from green relies on the text; somebody
     * reading a marker flagged high relies on being able to read it at all.
     * These carry meaning, so they are held to the same bar as body text.
     */
    for (const status of ['good', 'bad', 'warn', 'accent']) {
      for (const surface of ['bg', 'surface']) {
        const ratio = contrast(palette[status]!, palette[surface]!)
        if (ratio < 4.5) {
          failures.push(`--${status} on --${surface}: ${ratio.toFixed(2)}:1`)
        }
      }
    }

    expect(failures).toEqual([])
  })

  test('text on the accent colour is readable too', () => {
    const palette = tokens()

    // The primary button. Getting this backwards is how a call to action
    // becomes the least readable thing on the screen.
    expect(contrast(palette['accent-ink']!, palette['accent']!)).toBeGreaterThanOrEqual(4.5)
  })

  test('the known-failing colour stays fixed', () => {
    // Named, because it regressed from exactly this value and the specific
    // number is what a reviewer would otherwise have to recompute.
    const palette = tokens()
    expect(palette['ink-3']).not.toBe('#6f6d68')
    expect(contrast(palette['ink-3']!, palette['surface-2']!)).toBeGreaterThanOrEqual(4.5)
  })
})
