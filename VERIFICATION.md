# What is verified, and what is not

This file exists because "it works" is a claim, and a claim without evidence is
worth nothing to anyone reading this repository. Everything below is either
reproducible from a command in this repo or explicitly marked as unverified.

Nothing here is aspirational. If a row says NOT VERIFIED, it means we could not
demonstrate it, not that we expect it to fail.

Last updated: 2026-08-24.

---

## Verified

### Automated suites

| Suite | Count | Command |
|---|---|---|
| `@ogt/core` — targets, safety, questions | 45 | `npm test -w @ogt/core` |
| `@ogt/og` — router, storage, payments | 38 | `npm test -w @ogt/og` |
| `@ogt/api` — services, routes, wiring | 113 | `npm test -w @ogt/api` |
| `@ogt/api` — end-to-end, idempotency, delivery | 30 | included above |
| `@ogt/web` — client and offline queue | 16 | `npm test -w @ogt/web` |
| `contracts` — Foundry | 94 | `forge test` in `packages/contracts` |

Contract coverage is 100% of lines, statements, branches and functions on both
`HealthRecordAnchor` and `CoachAgent`.

### The 0G Compute Router — live

`npm run test:live -w @ogt/og` runs six checks against
`GET https://router-api.0g.ai/v1/models`. No API key is required, so anyone can
run it and check the privacy claim rather than take it on trust.

As of the last run, against 29 live models:

- Every model in our chains exists on the Router.
- Every model in every chain reports `tee_attested: true`.
- Our recorded attestation flags match what the Router reports.
- Every model we send photographs to accepts image input.
- `claude-*` and `gpt-*` still report no attestation, and remain absent from
  every chain. They are proxied to their original providers — billing
  convenience, not confidential execution.

This is the load-bearing check for the sentence the app shows on its sign-in
screen. If it ever fails, that sentence has become false.

### 0G Chain — live and forked

- Galileo is reachable and reports chain id `0x40da` = **16602**. Some older
  documentation still says 16601; 16602 is what the network actually returns.
- `packages/contracts/script/verify-fork.sh` forks live Galileo with anvil and
  deploys both contracts against real chain state, real EVM configuration and
  real gas. It then anchors a snapshot as a user, reads it back, mints a coach,
  and asserts `ownerOf` is the user rather than the backend.

Measured against Galileo at block 51,177,774:

| Operation | Gas |
|---|---|
| Deploy both contracts | 4,440,685 |
| `anchorSnapshot` (one root hash) | 116,899 |
| `mintCoach` | 168,230 |

At the observed 4 gwei that is roughly 0.0178 0G to deploy.

### Security properties, demonstrated by test

Each of these is asserted by a test that fails if the property breaks:

- Every route not on the auth allowlist refuses an anonymous caller. The test
  enumerates the server's own route table, so a route added later is covered
  without anyone remembering to add it.
- A revoked session stops working immediately.
- A forged or truncated token is refused.
- A used one-time code cannot be replayed.
- Wrong codes are counted and the challenge is spent.
- An unauthenticated flood is refused by the rate limiter *before* the session
  lookup — observable because the status is 429 rather than 401.
- Requesting codes for many different numbers from one host is capped.
- The operator endpoint refuses a signed-in user without the operator secret.
- A profile that fails the safety gate is refused and written nowhere.
- A replayed write is applied once; a key reused for different content is
  refused; two concurrent replays cannot both run the write.

### Dependencies

`npm audit --omit=dev` reports **0 vulnerabilities**. Dev dependencies carry
known vite/vitest advisories; see the Known Gaps section.

---

## NOT VERIFIED

These are the honest gaps. Each says what is missing and what would close it.

### Inference against the live Router

**Status: not run.** Every model call in the test suites is answered by a stub.

The Router's catalogue endpoint is public and is verified above, but
`POST /v1/chat/completions` requires a funded inference key (`sk-`) created at
pc.0g.ai against a wallet holding 0G. Without one we have not measured:

- whether meal photographs are read accurately, or how often a question is
  needed (the product's central metric — median questions per meal below 0.3 by
  week 4),
- real latency for a photo round trip,
- real cost per meal,
- whether `verify_tee: true` returns the attestation receipt we parse, against a
  live provider rather than a fixture.

That last one matters most: TEE verification is the binding that makes 0G
irremovable from this product, and it has been verified only in unit tests.

The harness is written and waiting. `packages/og/tests/live/inference.test.ts`
asserts that a real request returns a verified TEE receipt naming the provider
that ran it, that the meal-vision path attests, and that every chain answers.
Without a key those four cases **skip loudly** rather than passing quietly — a
suite that goes green because it did nothing is worse than one that fails.

**To close it:** a funded `sk-` key, then

```bash
OG_ROUTER_API_KEY=sk-... npm run test:live -w @ogt/og
```

### Contracts on the live network

**Status: deployed and exercised on a fork, never broadcast.**

The anchoring path is now complete and end-to-end verified against a fork of
live Galileo with the contract actually deployed: the worker reads pending
snapshots, derives the owner account, signs EIP-712, and a relayer submits and
pays. `npm run test:fork -w @ogt/og`.

Until this session there was no such path at all — see the note below.

What a fork cannot answer is whether the live network accepts the broadcast,
and no address exists on Galileo yet.

**To close it:** a deployer key funded from the Galileo faucet, then
`forge script script/Deploy.s.sol:Deploy --rpc-url og_testnet --broadcast`, and
set `OG_ANCHOR_ADDRESS` plus `OG_ANCHOR_MASTER_SEED`.

### 0G Storage round trip

**Status: not run against live storage.** Upload and download are covered by
unit tests against the SDK's types, not against a live indexer. The fragmented
upload path in particular has never moved real bytes.

**To close it:** a funded `OG_STORAGE_PRIVATE_KEY` and a live indexer endpoint.

### SMS delivery

**Status: the path exists and is tested; no vendor account is connected.**

The delivery port, the HTTP adapter, the boot refusal and the failure handling
are all implemented and covered by sixteen tests, including an end-to-end case
asserting the code is handed to a sender and that the code delivered is the one
that verifies. What has not happened is a real message to a real handset.

The vendor is configuration rather than code, because India requires DLT
registration with an approved sender id and approved templates before a
transactional SMS delivers at all — work the operator must do regardless of
what this repository says.

**To close it:** a provider account, a DLT-approved template, and

```
SMS_PROVIDER_URL / SMS_PROVIDER_HEADERS / SMS_PROVIDER_BODY
```

Production refuses to boot without them, so this cannot be forgotten into a
deployment.

### Real users

**Status: none.** No usage data, no retention data, and no measurement of the
thesis metric. Everything about product-market fit in `PRD.md` is a hypothesis
drawn from research, not an observation.

---

## An open decision for the product owner

**Record-owning keys are custodial today.** Each user's on-chain account is
derived from one master seed held by the backend, so whoever holds that seed can
sign an anchor for any user.

This is what makes the product work as designed — sign-in is a phone number and
a six-digit code, and nobody is asked to keep a seed phrase. It is also strictly
weaker than the contract's own comment implies. What the anchor still provides:
an append-only public timeline nobody can rewrite, a record that outlives the
company, and a pointer the user can take elsewhere. What it does not provide:
protection from us specifically.

The relayed-anchor design was chosen so the fix stays cheap. Moving the key into
the user's browser changes who calls `signAnchor` and nothing else — no contract
change, no migration of existing records. What it costs is a recovery story for
a lost device, which is a product decision rather than an engineering one.

**This needs a decision before launch**, because the marketing copy depends on
it. Ship custodial and describe it accurately, or hold the ownership claim until
keys are user-held.

---

## Known gaps, not yet closed

- **Rate limits are per-process.** Running more than one instance multiplies
  every limit by the instance count. The server warns about this at boot in
  production. A shared store is required before scaling out.
- **Dev-dependency advisories.** `npm audit` reports 8 findings in the
  vite/vitest tree. Production dependencies are clean; these affect the local
  dev server and test runner only.

---

## Checking a deployment

`npm run preflight -w @ogt/api` answers one question against live systems: would
this deployment work right now? It checks the database and its migrations, the
SMS sender, the Router catalogue and a real attested inference call, the chain
id, the storage signer's balance, whether the anchor address holds code, and the
indexer. A required failure exits non-zero, so it can gate a deploy.

Run against this machine with placeholder credentials it reports, correctly:

```
  ok    config                  NODE_ENV=development, network=testnet
  FAIL  database                (none running here)
  warn  sms delivery            console sender — nobody can sign in in production
  ok    0G Router catalogue     29 models, every routed model TEE-attested
  FAIL  0G Router inference     key rejected — create an sk- inference key at pc.0g.ai
  ok    0G Chain RPC            chain 16602 at block 51180554
  FAIL  storage signer balance  holds nothing — storage writes will fail
  warn  HealthRecordAnchor      OG_ANCHOR_ADDRESS unset
  ok    0G Storage indexer      reachable
```

That is the honest state of this repository: the code paths are built and
tested, and the credentials are not yet supplied. Every FAIL above names what
supplies it.

---

## Reproducing all of it

```bash
npm install
npm test --workspaces                      # 248 tests, no network required
npm run test:live -w @ogt/og               # 6 live checks; 4 more with a key
cd packages/contracts && forge test        # 80 tests
bash script/verify-fork.sh                 # deploy + exercise on forked Galileo
npm run test:fork -w @ogt/og               # the whole anchoring path on a fork
npm run preflight -w @ogt/api              # check a deployment against live systems
```
