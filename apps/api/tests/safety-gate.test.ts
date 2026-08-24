/**
 * Safety gate enforcement.
 *
 * The unit behaviour of the gate is covered in @ogt/core. What these tests
 * guard is the thing that actually goes wrong in practice: a route that reaches
 * a model without passing through the gate first.
 *
 * That failure is invisible in normal testing — the app works, answers are
 * good, and the only symptom is that one day it coaches someone who disclosed
 * purging. So it is checked structurally, against the source.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { blockedResponse } from '../src/services/safety-gate.ts'
import { screenMessage } from '@ogt/core'

const ROUTES_DIR = join(import.meta.dirname, '..', 'src', 'routes')

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter((name) => name.endsWith('.ts'))
}

function read(file: string): string {
  return readFileSync(join(ROUTES_DIR, file), 'utf8')
}

test('every route that reaches a model also imports the safety gate', () => {
  // A route calling complete(), readMeal(), or extractFacts() is sending user
  // input to a model. It must screen that input first.
  for (const file of routeFiles()) {
    const source = read(file)
    const touchesModel = /\b(complete|readMeal|extractFacts)\s*\(/.test(source)
    if (!touchesModel) continue

    assert.match(
      source,
      /from '\.\.\/services\/safety-gate\.ts'/,
      `${file} calls a model but never imports the safety gate`,
    )
    assert.match(source, /\bguard(Profile)?\s*\(/, `${file} imports the gate but never calls it`)
  }
})

test('the chat route screens before it extracts or coaches', () => {
  const source = read('chat.ts')
  const guardAt = source.indexOf('await guard(')
  const extractAt = source.indexOf('extractFacts(')
  const completeAt = source.indexOf('complete(')

  assert.ok(guardAt > -1, 'chat route must call guard()')
  assert.ok(guardAt < extractAt, 'guard() must run before extraction')
  assert.ok(guardAt < completeAt, 'guard() must run before the coach replies')
})

test('the chat route returns early when the gate blocks', () => {
  const source = read('chat.ts')
  assert.match(
    source,
    /if \(gate\.blocked\)[\s\S]{0,400}return reply/,
    'a blocked message must return without reaching a model',
  )
})

test('the meal route screens the free-text note before reading the photo', () => {
  const source = read('meals.ts')
  const guardAt = source.indexOf('await guard(')
  const readAt = source.indexOf('readMeal(')
  assert.ok(guardAt > -1 && guardAt < readAt, 'the note must be screened before the model runs')
})

test('onboarding screens the profile before writing it', () => {
  const source = read('users.ts')
  const guardAt = source.indexOf('guardProfile(')
  const writeAt = source.indexOf('.update(users)')
  assert.ok(guardAt > -1, 'onboarding must screen the profile')
  assert.ok(writeAt > -1, 'onboarding must persist the profile')
  assert.ok(guardAt < writeAt, 'a refused profile must not be stored')

  // Stronger than ordering: there must be no way to mint a user here at all.
  // The row exists because someone proved they own a phone number, and a second
  // creation path would produce rows nobody can ever sign in to.
  assert.equal(
    source.includes('.insert(users)'),
    false,
    'profile routes must never create a user; only auth may',
  )
})

test('a blocked response carries a helpline for self-harm and ED signals', () => {
  const selfHarm = blockedResponse(screenMessage('i want to die'))
  assert.equal(selfHarm.blocked, true)
  assert.equal(selfHarm.helpline?.number, '14416')

  const ed = blockedResponse(screenMessage('i throw up after my meals'))
  assert.equal(ed.helpline?.number, '14416')
})

test('a blocked response never leaks reason codes to the client', () => {
  const response = blockedResponse(screenMessage('i want to die'))
  const serialised = JSON.stringify(response)
  assert.doesNotMatch(serialised, /self_harm|ed_purging/, 'internal codes must stay internal')
})

test('safety events are recorded by reason code only, never message text', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'safety-gate.ts'),
    'utf8',
  )
  // The insert must carry reasons, and must not carry the message.
  assert.match(source, /reasons:\s*verdict\.reasons/)
  assert.doesNotMatch(
    source,
    /\.values\(\{[\s\S]{0,300}text:\s*input\.text/,
    'the gate must never persist what the person typed',
  )
})

test('the coach prompt forbids prescribing below computed targets', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'coach.ts'),
    'utf8',
  )
  assert.match(source, /Never tell them to eat below the targets/i)
  assert.match(source, /Never diagnose/i)
})

test('the coach only sees unresolved facts', () => {
  // A resolved topic being raised again is a documented harm, not a nitpick:
  // a coach that kept surfacing a healed injury for three months and then
  // argued with the user about it.
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'coach.ts'),
    'utf8',
  )
  assert.match(source, /isNull\(lifeFacts\.resolvedAt\)/)
})
