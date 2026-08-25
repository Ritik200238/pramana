/**
 * Every client method has to be reachable from something a person can press.
 *
 * The single most expensive defect in this repository is not broken code. It is
 * correct, tested code that nothing calls — and the most costly instance of it
 * was the blood-report feature, marked in FEATURES.md as "the largest gap in the
 * entire research", which had a working route, a tested pipeline, and no way in.
 * From a user's side it did not exist. Nothing failed. No test went red.
 *
 * A method on the API client with no call site is that defect, caught early:
 * either something should render it or it should not be shipped.
 *
 * Kept as an explicit list rather than a count, so adding a method forces a
 * decision instead of quietly moving a number.
 */

import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

/** Methods that are deliberately not called from a screen, and why. */
const NOT_FROM_A_SCREEN: Record<string, string> = {
  // Called by App.tsx during boot, not from a screen.
  me: 'session restore',
  // Auth flow lives in SignIn, which calls these through its own handlers.
  requestCode: 'sign-in',
  verifyCode: 'sign-in',
  // Used by the offline queue, which flushes without anybody pressing anything.
  writeQueue: 'offline queue internals',
}

function readAll(dir: string, skip: string): string {
  let combined = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) combined += readAll(path, skip)
    else if (/\.tsx?$/.test(entry.name) && !path.endsWith(skip)) {
      combined += readFileSync(path, 'utf8')
    }
  }
  return combined
}

describe('the app can reach what it ships', () => {
  test('every API client method has a call site', () => {
    const client = readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8')
    const body = client.slice(client.indexOf('export const api = {'))

    const methods = Array.from(
      new Set(Array.from(body.matchAll(/^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)\(/gm), (m) => m[1]!)),
    )

    // If the parse finds nothing, everything below passes while checking
    // nothing — the exact shape of the guards this file exists to prevent.
    expect(methods.length).toBeGreaterThan(20)

    const app = readAll(SRC, join('lib', 'api.ts'))

    const unreachable = methods.filter(
      (method) =>
        !(method in NOT_FROM_A_SCREEN) &&
        !new RegExp(`\\.${method}\\s*\\(`).test(app),
    )

    expect(unreachable).toEqual([])
  })

  test('the exemption list stays honest', () => {
    // An exemption for a method that no longer exists is a comment pretending
    // to be a decision.
    const client = readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8')

    for (const method of Object.keys(NOT_FROM_A_SCREEN)) {
      expect(client).toMatch(new RegExp(`^ {2}(?:async )?${method}\\(`, 'm'))
    }
  })
})
