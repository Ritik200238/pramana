/**
 * Guards the dependency overrides in the root package.json.
 *
 * `@0gfoundation/0g-storage-ts-sdk` ships `open-jsonrpc-provider`, which pins
 * `axios@0.27.2` — a version carrying a high-severity advisory. We override it
 * to axios 1.x rather than accept the advisory, but a major bump of a
 * transitive HTTP client is exactly the kind of change that breaks quietly.
 *
 * These tests fail loudly if the override ever stops loading the SDK, so the
 * security fix cannot silently become a functionality regression.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

test('the storage SDK loads and exports what we depend on', async () => {
  const sdk = await import('@0gfoundation/0g-storage-ts-sdk')
  for (const name of ['Indexer', 'MemData', 'ZgFile', 'Batcher', 'KvClient']) {
    assert.ok(name in sdk, `SDK no longer exports ${name}`)
  }
})

test('MemData accepts an in-memory payload and reports its size', async () => {
  const { MemData } = await import('@0gfoundation/0g-storage-ts-sdk')
  const bytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
  const data = new MemData(bytes)
  assert.equal(data.size(), bytes.length)
})

test('an Indexer can be constructed against the testnet endpoint', async () => {
  const { Indexer } = await import('@0gfoundation/0g-storage-ts-sdk')
  const indexer = new Indexer('https://indexer-storage-testnet-turbo.0g.ai')
  assert.ok(indexer)
  assert.equal(typeof indexer.upload, 'function')
  assert.equal(typeof indexer.downloadToBlob, 'function')
})

test('axios is overridden to a patched major and still loads', () => {
  const version = require('axios/package.json').version as string
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10)
  assert.ok(major >= 1, `axios must be >=1.x to clear the advisory, got ${version}`)
  const axios = require('axios')
  assert.equal(typeof (axios.default ?? axios).get, 'function')
})

test('ethers is pinned to the version the SDK peers on', async () => {
  // ethers does not expose ./package.json through its exports map, so resolve
  // the installed manifest from disk rather than through the module system.
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const entry = require.resolve('ethers')
  const manifest = findManifest(entry, dirname, join, readFileSync)
  assert.equal(
    manifest.version,
    '6.13.1',
    'The storage SDK peer-depends on exactly ethers 6.13.1. Changing this breaks installation.',
  )
})

function findManifest(
  entry: string,
  dirname: (p: string) => string,
  join: (...p: string[]) => string,
  readFileSync: (p: string, e: 'utf8') => string,
): { name: string; version: string } {
  let dir = dirname(entry)
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (parsed.name === 'ethers' && parsed.version) {
        return { name: parsed.name, version: parsed.version }
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Could not locate the installed ethers manifest from ${entry}`)
}
