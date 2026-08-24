/**
 * Which writes must not happen twice.
 *
 * `IDEMPOTENT_ROUTES` is a hand-maintained list, and every hand-maintained list
 * in this repository has drifted from the thing it describes. This one had:
 * `POST /users/me/reports` creates a lab report and reads it with a vision
 * model, and it was missing. A retry, a double tap, or an offline replay
 * produced two reports and paid for the reading twice — the most expensive
 * write here to repeat by accident.
 *
 * So the answer is derived from the handlers instead of trusted from the list.
 * A route that inserts a row a person would notice twice has to be on it, or
 * has to be named below with a reason it should not be.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDEMPOTENT_ROUTES } from '../src/plugins/idempotency.ts'

const SRC = join(import.meta.dirname, '..', 'src')

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8')
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/**
 * Tables whose rows are bookkeeping rather than something a person sees.
 *
 * A duplicate row in any of these is invisible and harmless; a duplicate meal,
 * weight or lab report is not.
 */
const INVISIBLE = ['inferenceUsage', 'safetyEvents', 'idempotencyKeys', 'sessions', 'otpChallenges']

/** Writes that may legitimately repeat, with the reason. */
const REPEATABLE: Record<string, string> = {
  'POST /chat':
    'saying the same sentence twice is a thing people do, and the second one is ' +
    'a real message rather than a duplicate of the first.',
  'POST /meals/draft':
    'returns a draft and writes nothing. Repeating it costs a model call, which ' +
    'the per-user cost limit already bounds, and creates no row to duplicate.',
  'POST /meals/draft-text':
    'the same: a draft, no write. Matched here only because it shares a module ' +
    'with the code that does write.',
  'PATCH /meals/:mealId/items/:itemId':
    'idempotent by construction. Applying the same correction twice sets the ' +
    'same values and upserts the same personal food, so the second changes ' +
    'nothing — there is no duplicate to prevent.',
}

/**
 * Service functions that insert a row a person would notice.
 *
 * Route handlers mostly delegate, so scanning only the handlers found almost
 * nothing — the first version of this missed POST /meals/commit, the most
 * obvious creating route in the product, and the coverage check below passed
 * because it had nothing to check.
 */
function creatingServices(): string[] {
  const names: string[] = []

  for (const file of [
    ['services', 'meal-log.ts'],
    ['services', 'corrections.ts'],
    ['services', 'streaks.ts'],
    ['services', 'food-library.ts'],
    ['pipeline', 'lab-report.ts'],
  ]) {
    const source = code(read(...file))

    /*
     * Every exported function of a module that creates something, rather than
     * only the one containing the insert.
     *
     * Attributing inserts to individual functions was tried and is too
     * fragile: slicing between exported declarations credited a helper defined
     * above the real writer, so the route that calls `commitMealAndStreak` —
     * the most obvious creating route in the product — was not matched.
     *
     * Coarser deliberately. Over-matching forces somebody to make an explicit
     * decision about a route, which is the whole point; under-matching lets one
     * through in silence, which is the bug this file exists for.
     */
    const inserts = [...source.matchAll(/\.insert\((\w+)\)/g)].map((m) => m[1]!)
    if (!inserts.some((table) => !INVISIBLE.includes(table))) continue

    for (const match of source.matchAll(/export (?:async )?function (\w+)/g)) {
      names.push(match[1]!)
    }
  }

  return names
}

/** Every route that creates a row somebody would notice appearing twice. */
function creatingRoutes(): string[] {
  const services = creatingServices()
  const found: string[] = []

  for (const file of ['meals.ts', 'chat.ts', 'coach.ts', 'day.ts', 'users.ts']) {
    const source = code(read('routes', file))
    const registrations = [
      ...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g),
    ]

    for (const [index, match] of registrations.entries()) {
      const verb = match[1]!.toUpperCase()
      if (verb === 'GET') continue

      const start = match.index ?? 0
      const end = registrations[index + 1]?.index ?? source.length
      const handler = source.slice(start, end)

      const directInserts = [...handler.matchAll(/\.insert\((\w+)\)/g)]
        .map((m) => m[1]!)
        .filter((table) => !INVISIBLE.includes(table))

      // Substring rather than a built pattern. Assembling a regex from a name
      // has silently produced a pattern matching nothing more than once here,
      // and a check that matches nothing passes.
      const viaService = services.some((name) => handler.includes(`${name}(`))

      if (directInserts.length > 0 || viaService) found.push(`${verb} ${match[2]}`)
    }
  }

  return [...new Set(found)]
}

test('the scan finds the routes we already know create things', () => {
  const routes = creatingRoutes()

  // If this parse breaks, the check below passes for the wrong reason.
  assert.ok(routes.includes('POST /meals/commit'), `saw ${routes.join(', ')}`)
  assert.ok(routes.length >= 3, `only found ${routes.length} creating routes`)
})

test('every route that creates something is idempotent or excused', () => {
  const unprotected = creatingRoutes().filter(
    (route) => !IDEMPOTENT_ROUTES.includes(route) && !(route in REPEATABLE),
  )

  assert.deepEqual(
    unprotected,
    [],
    'add these to IDEMPOTENT_ROUTES, or to REPEATABLE with a reason',
  )
})

test('nothing is excused without a reason', () => {
  for (const [route, reason] of Object.entries(REPEATABLE)) {
    assert.ok(reason.length > 40, `${route} needs a real reason, not a placeholder`)
  }
})

test('the idempotent list names only routes that exist', () => {
  // The other direction: a renamed route leaves a dead string, and the
  // protection it described silently covers nothing.
  let declared = ''
  for (const file of ['meals.ts', 'chat.ts', 'coach.ts', 'day.ts', 'users.ts']) {
    declared += code(read('routes', file))
  }

  for (const route of IDEMPOTENT_ROUTES) {
    const path = route.slice(route.indexOf(' ') + 1)
    assert.ok(declared.includes(`'${path}'`), `${route} is declared but no route registers it`)
  }
})
