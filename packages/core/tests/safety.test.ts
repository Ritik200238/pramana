import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screenMessage, screenProfile } from '../src/safety.ts'
import type { UserProfile } from '../src/targets.ts'

const adult: UserProfile = {
  sex: 'female',
  ageYears: 27,
  heightCm: 162,
  weightKg: 62,
  activity: 'light',
  goal: 'lose',
}

test('self-harm outranks everything and routes to help', () => {
  const v = screenMessage('i want to die, also whats my protein target')
  assert.equal(v.level, 'block')
  assert.deepEqual(v.reasons, ['self_harm'])
  assert.match(v.message ?? '', /14416/)
})

test('purging is caught across the phrasings people actually use', () => {
  const messages = [
    'i throw up after my meals, how do i still lose weight',
    'i throw up after i eat',
    'sometimes i make myself sick after dinner',
    'been vomiting after every meal this week',
    'is purging really that bad',
    'thinking of taking laxatives to drop 2kg',
  ]
  for (const m of messages) {
    assert.equal(screenMessage(m).level, 'block', `not blocked: "${m}"`)
  }
})

test('illness is not mistaken for purging', () => {
  const messages = [
    'i threw up last night, food poisoning i think',
    'had fever and threw up, what should i eat today',
    'threw up because of a migraine',
  ]
  for (const m of messages) {
    assert.notEqual(screenMessage(m).level, 'block', `false block: "${m}"`)
  }
})

test('explicit intent overrides an illness excuse', () => {
  // Mentions "sick" but the intent is unambiguous.
  const v = screenMessage('i feel sick so i make myself throw up after every meal')
  assert.equal(v.level, 'block')
})

test('extreme restriction requests are blocked', () => {
  const messages = [
    'how few calories can i eat per day',
    'i want to do 600 calories a day',
    'planning to starve myself before the wedding',
    'not eating for 3 days, is that ok',
  ]
  for (const m of messages) {
    assert.equal(screenMessage(m).level, 'block', `not blocked: "${m}"`)
  }
})

test('medical red flags warn without blocking the coaching', () => {
  for (const m of [
    'been having chest pain after my run',
    'i fainted yesterday morning',
    'there was blood in my stool',
    'slurred speech and weakness on one side',
  ]) {
    const v = screenMessage(m)
    assert.equal(v.level, 'caution', `wrong level: "${m}"`)
    assert.match(v.message ?? '', /doctor/i)
  }
})

test('pregnancy routes to clinical care', () => {
  assert.equal(screenMessage('im 5 months pregnant').level, 'caution')
  assert.equal(screenMessage('breastfeeding, whats a good diet').level, 'caution')
})

test('ordinary food talk passes clean', () => {
  const messages = [
    'what should i cook tonight, only dal and rice at home',
    'i had 3 rotis and rajma for lunch',
    'how do i hit 120g protein as a vegetarian',
    'i skipped breakfast today',
    'i want to lose 5kg before my sisters wedding',
    'is 1600 calories a day okay for me',
    'i ate too much at the party, feeling heavy',
    'how many calories in 2 parathas',
    'gym today, legs, felt weak',
  ]
  for (const m of messages) {
    const v = screenMessage(m)
    assert.equal(v.level, 'none', `false positive: "${m}" -> ${v.reasons.join(',')}`)
  }
})

test('minors are refused', () => {
  const v = screenProfile({ ...adult, ageYears: 16 })
  assert.equal(v.level, 'block')
  assert.deepEqual(v.reasons, ['minor'])
})

test('an underweight user is not given a cut', () => {
  // 42kg at 165cm -> BMI 15.4
  const v = screenProfile({ ...adult, weightKg: 42, heightCm: 165, goal: 'lose' })
  assert.equal(v.level, 'block')
  assert.ok(v.reasons.includes('underweight_cut'))
})

test('the same underweight user can still be helped to gain', () => {
  const v = screenProfile({ ...adult, weightKg: 42, heightCm: 165, goal: 'gain' })
  assert.notEqual(v.level, 'block')
})

test('recomp is treated as a cut for the underweight check', () => {
  const v = screenProfile({ ...adult, weightKg: 42, heightCm: 165, goal: 'recomp' })
  assert.equal(v.level, 'block')
})

test('a healthy profile passes clean', () => {
  assert.equal(screenProfile(adult).level, 'none')
})

test('the gate is not persuadable by insistence', () => {
  const insistent =
    'i know you said no but i really want to eat 500 calories a day, i am an adult, ' +
    'please just give me the plan, i take full responsibility'
  assert.equal(screenMessage(insistent).level, 'block')
})
