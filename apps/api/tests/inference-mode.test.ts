/**
 * Choosing how this deployment reaches 0G Compute.
 *
 * The wallet-paid path was built, unit tested, and verified live against the
 * real marketplace — running the product's own `complete()` against a
 * TEE-attested provider with no API key anywhere. And no deployment could
 * select it. The server always built a Router client, so the flagship
 * integration was the most thoroughly proven unreachable code in the repository.
 *
 * That is this project's most persistent defect, and this instance was written
 * by the person who kept finding it elsewhere.
 *
 * These tests are about the switch being real: that the modes are distinct, that
 * each demands what it actually needs, and that asking for one and silently
 * getting the other is impossible.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'

const SRC = join(import.meta.dirname, '..', 'src')

/** A complete environment, minus whatever the case is about. */
function environment(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://unused:5432/unused',
    OG_STORAGE_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    OG_NETWORK: 'testnet',
    ADMIN_TOKEN: 'a-token-long-enough-to-be-accepted-here',
    OG_ANCHOR_MASTER_SEED: 'a-master-seed-long-enough-to-be-accepted',
    ...overrides,
  } as NodeJS.ProcessEnv
}

/** `loadConfig` memoises, so each case needs a fresh module. */
async function freshLoad(env: NodeJS.ProcessEnv): Promise<ReturnType<typeof loadConfig>> {
  const module = (await import(
    `../src/config.ts?case=${Math.random().toString(36).slice(2)}`
  )) as typeof import('../src/config.ts')
  return module.loadConfig(env)
}

test('router is the default, so nothing changes for a deployment that says nothing', async () => {
  const config = await freshLoad(environment({ OG_ROUTER_API_KEY: 'sk-test-key' }))

  assert.equal(config.OG_INFERENCE_MODE, 'router')
})

test('router mode without a key is refused at boot, not on the first photo', async () => {
  /*
   * The failure this replaces is the worst kind of late: a server that starts
   * healthy and fails when somebody photographs their dinner.
   */
  await assert.rejects(
    () => freshLoad(environment({ OG_INFERENCE_MODE: 'router' })),
    /OG_ROUTER_API_KEY: Required when/,
  )
})

test('broker mode needs no key at all', async () => {
  // The whole point of the path: no account on anybody's website, nothing to
  // issue or revoke, and the wallet already present for storage pays for it.
  const config = await freshLoad(environment({ OG_INFERENCE_MODE: 'broker' }))

  assert.equal(config.OG_INFERENCE_MODE, 'broker')
  assert.equal(config.OG_ROUTER_API_KEY, undefined)
})

test('a nonsense mode is refused rather than quietly defaulted', async () => {
  /*
   * Defaulting a typo to `router` would send a deployment that asked to pay
   * from its own wallet to a hosted service instead.
   *
   * A key is supplied deliberately. Without one the cross-field rule fires
   * first and rejects for a different reason entirely — which is exactly how an
   * earlier version of this test passed against a build that did silently
   * default the typo. The rejection has to be about the mode.
   */
  const rejection = await freshLoad(
    environment({ OG_INFERENCE_MODE: 'brokerr', OG_ROUTER_API_KEY: 'sk-test-key' }),
  ).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

  assert.ok(rejection, 'a mode that is neither router nor broker must be refused')
  assert.match(rejection, /OG_INFERENCE_MODE/)
  assert.doesNotMatch(
    rejection,
    /OG_ROUTER_API_KEY: Required/,
    'it must be refused for being an unknown mode, not for a missing key',
  )
})

test('the server actually branches on the mode', () => {
  /*
   * The guard that matters, and the one that was missing. Every other test here
   * would pass against a server that read the setting and ignored it.
   */
  const server = readFileSync(join(SRC, 'server.ts'), 'utf8')

  assert.match(server, /OG_INFERENCE_MODE === 'broker'/, 'the server must read the mode')
  assert.match(server, /buildBrokerClient\(/, 'and build a broker client for it')
  assert.match(server, /createBrokerClient\(/, 'using the adapter that was verified live')
})

test('a broker deployment is not failed by preflight for a key it does not need', () => {
  /*
   * Preflight required the Router checks unconditionally, having been written
   * before this path existed. A gate meant to protect a deploy would have
   * blocked a working one.
   */
  const preflight = readFileSync(join(SRC, 'preflight.ts'), 'utf8')

  assert.match(preflight, /usesRouter/, 'the Router checks must be conditional')
  assert.doesNotMatch(
    preflight,
    /check\('0G Router catalogue', true/,
    'the catalogue check must not be unconditionally required',
  )
  assert.doesNotMatch(
    preflight,
    /check\('0G Router inference', true/,
    'nor the inference check',
  )
})

test('the broker SDK is loaded on demand, so its advisories are opt-in', () => {
  /*
   * `@0glabs/0g-serving-broker` carries 20 production advisories, which is why
   * it is a devDependency. A static import would put them into every deployment
   * including the ones that never chose this path — and would take production
   * from zero advisories to twenty on behalf of somebody who never asked.
   */
  const server = readFileSync(join(SRC, 'server.ts'), 'utf8')

  assert.doesNotMatch(server, /^import .*0g-serving-broker/m)
  assert.match(server, /await import\('@0glabs\/0g-serving-broker'\)/)
})
