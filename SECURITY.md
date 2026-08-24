# Dependency security

Run `npm audit --omit=dev` to check what actually ships.

## Current state

| Scope | Result |
|---|---|
| **Production (`--omit=dev`)** | **0 vulnerabilities** |
| Including devDependencies | 4 moderate, all in one dev-only chain (below) |

## Deliberate pins and overrides

These are load-bearing. Removing them either breaks installation or reopens an
advisory, so each one says why it exists.

### `ethers` pinned to exactly `6.13.1`
`@0gfoundation/0g-storage-ts-sdk` peer-depends on exactly this version. A caret
range resolves to 6.17.x and installation fails outright.

Guarded by `packages/og/tests/sdk-integrity.test.ts`, which fails if the version
ever moves.

### `overrides: { "axios": "^1.7.9" }`
The storage SDK ships `open-jsonrpc-provider@0.2.1`, which pins `axios@0.27.2` —
a version carrying a high-severity advisory. We override to axios 1.x rather
than accept it.

A major bump of a transitive HTTP client is exactly the change that breaks
quietly, so `sdk-integrity.test.ts` asserts the SDK still loads, constructs an
`Indexer`, and accepts a `MemData` payload under the override. The security fix
cannot silently become a functionality regression.

**Upstream fix wanted:** `open-jsonrpc-provider` should move off axios 0.27.

### `overrides: { "ws": "^8.20.2" }`
`ethers@6.13.1` pulls a `ws` version affected by a memory-exhaustion advisory.
We reach the chain over HTTP (`JsonRpcProvider`), not WebSockets, so the
vulnerable path is not exercised — but the override removes the question rather
than relying on that argument holding forever.

### `drizzle-orm` at `^0.45.2`
Anything below 0.45.2 carries a high-severity advisory. Pinned to the patched
line.

## Accepted, documented, dev-only

`drizzle-kit@0.31.10` bundles `@esbuild-kit/*` and an older `esbuild`, producing
4 moderate advisories.

**Accepted because:**
- `drizzle-kit` is a `devDependency`. It generates SQL migrations at development
  time and is never installed or executed in production.
- `npm audit --omit=dev` reports zero, confirming none of it ships.
- The advisories concern esbuild's local dev server, which we do not run.

**Not accepted forever.** Recheck when drizzle-kit updates its esbuild chain. If
this ever appears in a production audit, it stops being acceptable immediately.

## What this file does not claim

Zero production advisories means no *known, published* vulnerability in the
dependency tree. It says nothing about our own code, and it is a point-in-time
statement — new advisories are published against unchanged dependencies all the
time.

Contract-specific threats are in `packages/contracts/SECURITY.md`.
