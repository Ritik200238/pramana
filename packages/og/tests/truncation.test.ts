/**
 * A model that ran out of room mid-answer.
 *
 * `finish_reason: 'length'` was read nowhere, so a truncated completion came
 * back as an ordinary success. Two different harms come out of that, and they
 * need different answers.
 *
 * For the coach — prose, five hundred tokens — a long reply is cut mid-word,
 * shown to somebody as though it were finished, and stored as an assistant turn
 * that later gets replayed as context. For anything asking for strict JSON, the
 * partial text reaches `JSON.parse` far from here and fails with a message about
 * the shape of the answer rather than its length, which sends whoever is
 * debugging it in exactly the wrong direction.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { complete } from '../src/index.ts'
import { MODELS } from '../src/models.ts'

/** A client that answers however the test tells it to, once per call. */
function clientReturning(answers: Array<{ content: string; finish: string }>) {
  let call = 0
  return {
    chat: {
      completions: {
        async create() {
          const answer = answers[Math.min(call, answers.length - 1)]!
          call += 1
          return {
            id: 'chatcmpl-test',
            model: 'test',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: answer.content },
                finish_reason: answer.finish,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }
        },
      },
    },
    get calls() {
      return call
    },
  }
}

const CHAIN = [MODELS.qwen37plus]

test('a complete answer is not marked truncated', async () => {
  const client = clientReturning([{ content: 'All done.', finish: 'stop' }])

  const result = await complete(client as never, {
    task: 'coach',
    models: CHAIN,
    verifyTee: false,
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(result.truncated, false)
  assert.equal(result.text, 'All done.')
})

test('prose that was cut off is returned, and says it was cut off', async () => {
  /*
   * Returned rather than refused. A coach reply that stops mid-sentence is
   * still worth more than nothing, and whoever shows it is better placed than
   * this function to decide — but they can only decide if they are told.
   */
  const client = clientReturning([
    { content: 'Protein was short yesterday, so try adding cur', finish: 'length' },
  ])

  const result = await complete(client as never, {
    task: 'coach',
    models: CHAIN,
    verifyTee: false,
    messages: [{ role: 'user', content: 'how am I doing?' }],
  })

  assert.equal(result.truncated, true, 'the caller must be told the answer was cut off')
  assert.match(result.text, /try adding cur$/)
})

test('strict JSON that was cut off is not handed on as an answer', async () => {
  /*
   * Half a JSON object is not a smaller answer, it is a different kind of
   * failure. Passing it on produces a parse error far from here, blaming the
   * shape of the response rather than its length.
   */
  const client = clientReturning([
    { content: '{"items":[{"name":"dal","gram', finish: 'length' },
    { content: '{"items":[{"name":"dal","grams":150}]}', finish: 'stop' },
  ])

  const result = await complete(client as never, {
    task: 'extraction',
    models: [MODELS.qwen37plus, MODELS.qwen38max],
    verifyTee: false,
    jsonSchema: { name: 'meal', schema: { type: 'object' } },
    messages: [{ role: 'user', content: 'one katori dal' }],
  })

  // The next model has its own tokenizer and may well fit the same content, so
  // one more attempt is worth making before giving up.
  assert.equal(result.failovers, 1, 'a truncated JSON answer must advance the chain')
  assert.equal(result.truncated, false)
  assert.deepEqual(JSON.parse(result.text), { items: [{ name: 'dal', grams: 150 }] })
})

test('a chain that only ever truncates fails rather than returning fragments', async () => {
  const client = clientReturning([{ content: '{"items":[{"na', finish: 'length' }])

  await assert.rejects(
    () =>
      complete(client as never, {
        task: 'extraction',
        models: [MODELS.qwen37plus, MODELS.qwen38max],
        verifyTee: false,
        jsonSchema: { name: 'meal', schema: { type: 'object' } },
        messages: [{ role: 'user', content: 'a very long plate' }],
      }),
    'every model truncating must be an error, not a fragment',
  )
})
