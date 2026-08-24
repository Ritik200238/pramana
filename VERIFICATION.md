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
| `@ogt/og` — router, storage, encryption, speech, claims, cost | 78 | `npm test -w @ogt/og` |
| `@ogt/api` — services, routes, wiring | 194 | `npm test -w @ogt/api` |
| `@ogt/api` — end-to-end, idempotency, delivery | 30 | included above |
| `@ogt/web` — client, offline queue, reachability, caching | 34 | `npm test -w @ogt/web` |
| `contracts` — Foundry | 108 | `forge test` in `packages/contracts` |

Contract coverage is 100% of lines, statements, branches and functions on both
`HealthRecordAnchor` and `CoachAgent`.

### The 0G Compute Router — live

`npm run test:live -w @ogt/og` runs six checks against
`GET https://router-api.0g.ai/v1/models`. No API key is required, so anyone can
run it and check the privacy claim rather than take it on trust.

As of the last run, against 29 live models:

- Every model in our chains exists on the Router.
- Every model in every chain reports `tee_attested: true`.
- Our published per-token prices match the catalogue exactly.
- We send no parameter a model does not advertise, our default output length
  fits every model's ceiling, and no chain is entirely single-provider.
- Our recorded attestation flags match what the Router reports.
- Every model we send photographs to accepts image input.
- `claude-*` and `gpt-*` still report no attestation, and remain absent from
  every chain. They are proxied to their original providers — billing
  convenience, not confidential execution.

This is the load-bearing check for the claim the app makes on its sign-in
screen. If it ever fails, that claim has become false.

**What `verified` means, precisely.** 0G's documentation is explicit: the Router
fetches the provider's TEE signature, looks the signer up on chain, checks it,
and returns one boolean. It does not return the signature. So `tee_verified:
true` is the Router's word that it did the check — traceable to a named provider
and request id, and still somebody else's assertion rather than a proof anybody
can re-run. The app says exactly this, on the screen showing the receipts.

The product previously claimed "Nobody — including us — could read them". That
was false twice: the Router relays the plaintext, and records are encrypted to a
key we hold. Four tests now fail if that sentence returns.

### The four 0G bindings, and whether each does work

The product was meant to bind to 0G four ways. Two of them were, until this
session, contracts nothing could reach — complete, fully covered, and with no
call sites in the running product at all.

| Binding | Mechanism | Reaches the running product |
|---|---|---|
| Intelligence | 0G Compute Router, `verify_tee` | yes |
| Memory | 0G Storage, ECIES per user | yes |
| Record ownership | `HealthRecordAnchor` | yes, since this session |
| Coach ownership | `CoachAgent`, ERC-721 with ERC-7857 semantics | yes, since this session |
| Payments | 0G Pay | **no — see below** |

`npm run test:fork -w @ogt/og` drives both chain bindings end to end against a
fork of live Galileo with the contracts actually deployed: derive the owner
account, sign EIP-712, relay and pay, then read back that the record and the
coach belong to the user rather than to whoever paid.

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

### Performance, measured rather than asserted

Query plans taken against real Postgres with realistic row counts, not reasoned
about. Both checks came back clean, and one of them talked me out of a change.

| Query | Scale | Plan | Time |
|---|---|---|---|
| Personal food search | 60,300 rows, 300 per user | Bitmap index scan on `user_foods_unique_idx`, top-N heapsort | 1.16 ms |
| Users due for a snapshot | 50,000 users, 49,045 with recent snapshots | Merge anti join, index-only both sides | 9.7 ms |

The food search orders by `times_logged` with no index on it, which looks like a
missing index until you read the query: the filter is `ILIKE '%term%'`, a leading
wildcard no B-tree can serve, so the rows must be fetched and filtered before
anything is sorted. The composite unique index already covers the user filter
through its leading column. An index on `times_logged` would not have been used
and would have cost write throughput on a table written to on every correction.

Earlier in the same family: session lookup is an index scan at 0.2 ms over 5,000
sessions, and no endpoint issues N+1 queries — counts are flat, three to five per
request including authentication.

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
- A photo must be inline base64 in a camera format. A remote URL would be
  fetched by a provider on our account, so links, non-images and SVG are all
  refused.
- The service worker caches only reads that benefit from working offline, never
  the export or anything under `/auth`, and the cache is emptied whenever a
  session ends. Checked against the built service worker, not the config.
- A meal logged offline is sent only to the person who logged it. Somebody
  else's queued meals are left untouched rather than flushed into whoever signs
  in next.
- A replayed write is applied once; a key reused for different content is
  refused; two concurrent replays cannot both run the write.
- Every route whose handler calls a model appears in the per-user cost limits,
  derived from the handlers rather than trusted from a list — and every route
  string in that list names a path some route actually registers.

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

### Records encrypt and decrypt — proved, no credentials needed

The failure this rules out is the quietest one available: a key of the wrong
shape means every upload still succeeds while the ciphertext is permanently
unreadable, and nobody learns it until somebody asks for their data back.

The SDK exports the same ECIES primitives its upload path uses, so the round
trip is proved with real cryptography in `packages/og/tests/encryption.test.ts`:

- the derived key is a compressed secp256k1 point the SDK accepts unchanged
  (reverting to an uncompressed key makes the suite fail, so the check is real)
- a record decrypts byte for byte, including non-ASCII food names
- one user's key cannot read another's
- a rotated master seed cannot read what the original wrote
- the header survives a round trip through bytes
- every encryption uses a fresh ephemeral key
- a fragmented payload decrypts correctly from a non-zero offset

Reads now also request Merkle proof verification. That is not belt-and-braces:
the cipher is malleable and carries no authentication tag, so altered ciphertext
decrypts to altered plaintext rather than failing. The proof is the only check
in that path.

This does not prove a live indexer returns the bytes unchanged. It proves that
when they come back, they decrypt.

### 0G Storage round trip

**Status: not run against live storage — and, until this session, unreachable
for a second reason.**

This gap was reported for weeks as waiting on a funded key. That was not the
whole story. `users.record_pub_key` was never written by anything, and the
snapshot query filtered `WHERE record_pub_key IS NOT NULL`, so it matched no
rows for any user. With a fully funded key, nothing would have uploaded.

That is fixed: the key is derived on demand, the queries no longer filter on it,
and an unconfigured master seed is an error in the log rather than an empty
queue. A freshly onboarded user is now provably snapshot-eligible, asserted
end to end against a real database.

What remains is genuinely the credential: upload and download are covered
against the SDK's types, not a live indexer, and the fragmented upload path has
never moved real bytes.

**To close it:** a funded `OG_STORAGE_PRIVATE_KEY` and `OG_ANCHOR_MASTER_SEED`.

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

## The shape every defect here has had

Sixteen sweeps, thirteen of them yielding, and the productive ones are all one
pattern: **something maintained by hand that mirrors something authoritative.**

A price list mirroring the catalogue. A capability flag mirroring
`supported_parameters`. A compliance claim mirroring a published interface. A
table list mirroring the schema. A route list mirroring the routes. An example
env file mirroring the config.

Every one of them drifted, and none failed a test — because the test mirrored
the same hand-maintained list. The fix was the same each time: derive the check
from the authoritative source, then prove the check fails when the thing it
guards is broken.

That last step matters. Three guards written during these sweeps were themselves
inert on the first attempt — one contained a control character from a shell
escaping mistake and matched nothing at all while passing. A guard nobody has
tried to break is not evidence.

---

## Sweeps run, and what each found

Every defect found in this repository has had the same shape: something built
and correct in isolation that nothing reached. None failed a test, because each
piece did its own job properly. They are only visible from outside.

| Sweep | Found |
|---|---|
| Exported behaviour with no call site | the anchor worker, the coach, `purgeExpired` |
| Contract functions never called | `CoachAgent` entirely; `grantAccess`; 0G Pay |
| Columns never written | `record_pub_key` — silently disabling three 0G bindings |
| API routes with no UI caller | twelve features, including no way to sign out |
| Route-pattern strings vs real routes | speech transcription with no cost ceiling |
| Columns never read, config never used | `anchor_address`, and a false security comment |
| Error paths no test exercises | two untested refusals; no defect |
| Request shapes vs the official API docs | voice notes ran with no TEE verification |
| Product claims vs what the docs support | the privacy sentence overstated its evidence |
| Published prices vs the live catalogue | three drifted; vision undercounted by 46% |
| Reported values we receive and discard | the exact per-request charge was thrown away |
| Request parameters vs model capabilities | temperature sent to a model that rejects it |
| SDK options vs the storage docs | records read back without proof verification |
| Failover behaviour vs the documented error table | a rate limit walked the chain instead of stopping |
| Operational blind spots vs the account docs | nothing watched the balance the product runs on |
| A claimed standard vs its published interface | the coach was described as ERC-7857 and is not |
| A hand-maintained list vs the schema it mirrors | the export omitted seven tables, receipts included |
| Migrations vs the schema | clean — no drift |
| .env.example vs the config it documents | three operational knobs undocumented |
| A capability a comment claimed vs what a user could do | storage pointers nobody could decrypt |
| Client response types vs what the API sends | clean; two shared shapes were copies and are now imported |
| Unbounded inputs reaching a model or a provider | image routes accepted any URL, fetched on our account |
| What the service worker caches, on a shared device | a day of health records survived sign-out |
| What else survives sign-out on a shared device | queued meals flushed into the next person's account |
| State captured once that should be read each time | the timezone offset, stale after travel |
| Query plans vs the indexes declared, at scale | clean; measured, and one tempting index rejected |
| Events and timers with no counterpart | nothing; all clean |

Guards were left behind for five of the six, each verified by mutation rather
than assumed — one guard was itself inert on the first attempt and passed while
detecting nothing, which is the same failure it existed to catch.

The last two classes have now been swept. Error paths: thirteen of seventeen
(route, status) pairs were already asserted, two were genuinely untested and are
now covered, one was defensive and unreachable, one was my sweep mis-attributing
the global error handler. Events and timers: one emitter and one listener for
the only custom event, and all three interval timers stopped on close and
unref'd. **No defect in either.**

That is the first round to find nothing, which is weak evidence rather than
proof. The yield is falling — six classes, six findings, then two classes and
none — but a class nobody has thought of yet cannot be counted.

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

**What no longer waits on that decision.** A person can now ask for their record
key and take it (`?includeRecordKey=true`, offered as a separate action in the
app). With it and the root hashes, the encrypted copies on 0G are theirs to read
forever with none of this company involved. Custody stays shared — we can still
read them — but dependence does not. Until this existed, the export's 0G section
was pointers to ciphertext the recipient could not open, under a comment
claiming they were "sufficient to reconstruct the record without this API
existing at all".

---

## Built, but not yet reachable from the app

A sweep comparing registered API routes against the calls the web client
actually makes found twelve features that existed in the API and had no user
facing entry point at all. Six were fixed — sign out, the attestation receipts,
export, correcting a meal item, tone, "ask me less" — plus weight logging. A
test now asserts the ones carrying a promise stay reachable, and it was written
twice: the first version matched a bare method name and passed on a local helper
that shared it, which mutation testing exposed.

These remain built and unreachable, and are honest backlog rather than defects:

| Feature | Endpoint |
|---|---|
| Lab report photo → markers | `POST /users/me/reports`, `GET /users/me/markers` |
| Pantry ("what have I got in") | `PUT /users/me/pantry` |
| Resolving a remembered fact | `POST /users/me/facts/:factId/resolve` |
| Voice meal logging | `POST /meals/transcribe` |
| Food autocomplete | `GET /users/me/foods` |
| Active session list | `GET /auth/sessions` |

Run the sweep yourself: the script lives in the session scratchpad, and the
shape of it is simply every `app.<verb>('path')` in the API compared against
every path string in the web client.

---

## What the coach contract is, exactly

`CoachAgent` was described as an ERC-7857 token. Checked against the published
interface, it is not one. The standard specifies
`transfer(from, to, tokenId, sealedKey, proof)`,
`clone(to, tokenId, sealedKey, proof)` and
`authorizeUsage(tokenId, executor, permissions)`; this contract implements none
of those signatures and does not advertise the interface.

It follows the design — metadata encrypted to the owner, transfer by
re-encryption under a sealed key, admitted only against an oracle-verified proof
— and the gap is deliberate. The standard's `transfer` carries the new
ciphertext location inside `proof`, decoded by the oracle. No oracle is deployed
and that proof encoding is not specified in any documentation available here, so
adopting the signatures would mean inventing a format and calling the result
conformant.

So the accurate description is: an ERC-721 with ERC-7857 semantics. Five tests
assert that, including that `supportsInterface` does not claim ERC-7857 — a
standard half-implemented is worse than one honestly not implemented, because
the first is found by somebody's tooling failing rather than by reading.
Adopting the interface is a small change once a verifier and its proof format
exist.

---

## Contract capability the product does not yet use

Stated here rather than left for somebody to discover by grepping.

- **`grantAccess` / `revokeAccess`** — the contract can grant a doctor read
  authorisation over snapshots up to a pinned index, and revoke it. Nothing in
  the API or the app calls either. Doctor sharing today is the printable visit
  pack (feature 23), which is a document, not an on-chain grant.
- **0G Pay** — `packages/og/src/payments.ts` carries the Payment Layer
  addresses and unit conversion, and nothing imports them. Inference is billed
  through the Router key, and the PRD puts user-facing payments outside v1.

Neither is a defect; both are capability the product has not reached yet. They
are listed because "the contract supports it" and "the product does it" are
different claims, and the difference is exactly what hid the two bindings that
were fixed this session.

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
npm test --workspaces                      # 351 tests, no network required
npm run test:live -w @ogt/og               # 6 live checks; 4 more with a key
cd packages/contracts && forge test        # 108 tests
bash script/verify-fork.sh                 # deploy + exercise on forked Galileo
npm run test:fork -w @ogt/og               # anchoring and coach ownership on a fork
npm run preflight -w @ogt/api              # check a deployment against live systems
```
