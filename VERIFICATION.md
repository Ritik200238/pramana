# What is verified, and what is not

This file exists because "it works" is a claim, and a claim without evidence is
worth nothing to anyone reading this repository. Everything below is either
reproducible from a command in this repo or explicitly marked as unverified.

Nothing here is aspirational. If a row says NOT VERIFIED, it means we could not
demonstrate it, not that we expect it to fail.

Last updated: 2026-08-25.

---

## Check it yourself, without trusting this file

    npm run evidence

Reads every 0G claim back off public infrastructure — the Galileo RPC and the
deployed contracts. **No private key, no funds, no configuration**: every call
is a read, and it works from a fresh clone. It verifies that the contracts have
bytecode at the addresses claimed, that the end-to-end run's anchoring
transaction is in the block it says and was sent to the contract it says, that
the relayer paid for it, that coach tokens are owned by addresses which are not
the relayer, and that the coach whose owner kept teaching it carries a second
version.

Output at block 51,235,317:

```
The chain
  [PASS] reachable, and is 0G Galileo — chain id 16602
  [PASS] producing blocks — head at block 51235317

The contracts exist on it
  [PASS] HealthRecordAnchor has bytecode — 6623 bytes at 0x75016F7ce345E0527d20B5E08f273E42886D35A5
  [PASS] CoachAgent has bytecode — 12777 bytes at 0x52c576686Ee095DF9C04cbFB09c6BE1A775F04e7

The pipeline transaction is on it
  [PASS] the end-to-end run anchored a snapshot — block 51231709, 147008 gas, 1 event(s)
  [PASS] and it was sent to HealthRecordAnchor
  [PASS] paid for by the relayer, not by the record owner

The coach is a token somebody owns, and it changes as it learns
  [PASS] token 6 — owner 0x0015e4A6…ac757, 1 version, that owner holds 1
  [PASS]   its owner is not the relayer that paid for it
  [PASS] token 8 — owner 0xCDe6c483…5d282b, 2 versions, that owner holds 1
  [PASS]   its owner is not the relayer that paid for it
  [PASS] a coach that learned more recorded a second version — versionCount(8) = 2
```

If you would rather not run our code at all, the same numbers are on somebody
else's page:

- [HealthRecordAnchor](https://chainscan-galileo.0g.ai/address/0x75016F7ce345E0527d20B5E08f273E42886D35A5)
- [CoachAgent](https://chainscan-galileo.0g.ai/address/0x52c576686Ee095DF9C04cbFB09c6BE1A775F04e7)
- [The pipeline's anchoring transaction](https://chainscan-galileo.0g.ai/tx/0xd68b35dc830dbac369dc3b316ff9d995dacd362d0f20eee57b0417b4a7b9f19c)

The check found its own first defect on the first run: it asked the contract for
`coachCount`, which is a name the TypeScript client uses for `balanceOf`, so the
call hit no function and came back empty and the run reported the token
unreadable. The contract was right and the check was wrong — the more useful
direction for a check to fail in.

---

## Verified

### Automated suites

| Suite | Count | Command |
|---|---|---|
| `@ogt/core` — targets, safety, questions | 45 | `npm test -w @ogt/core` |
| `@ogt/og` — router, storage, encryption, speech, claims, cost | 78 | `npm test -w @ogt/og` |
| `@ogt/api` — services, routes, wiring | 198 | `npm test -w @ogt/api` |
| `@ogt/api` — end-to-end, idempotency, delivery | 30 | included above |
| `@ogt/web` — client, offline queue, reachability, caching | 41 | `npm test -w @ogt/web` |
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

### The pipeline, end to end, on the real network

`npm run test:pipeline -w @ogt/api` runs the sequence the product performs
rather than its parts: a person with one logged food and a weight becomes an
encrypted snapshot on 0G Storage, anchored on 0G Chain by the anchor worker, and
a coach minted by the coach worker — then the record is decrypted back with the
user's own derived key.

| Step | Result |
|---|---|
| Snapshot | 497 bytes, encrypted, root `0x41574138…e349579` |
| Anchor | tx `0xd68b35dc…7b9f19c`, index 0 |
| Coach | token 6, learned count 1 |
| Read back | decrypts with the user's key |

This matters more than the individual checks above it. Almost every defect found
in this repository lived in a handoff rather than in a part — a worker nothing
called, a column nothing wrote, a list drifted from the routes it named — and
each piece passing its own test said nothing about whether they connect.

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

### 0G Chain — DEPLOYED AND EXERCISED LIVE

Both contracts are on 0G Galileo (chain 16602), and both were used after
deployment rather than merely deployed:

| | Address |
|---|---|
| `HealthRecordAnchor` | `0x75016F7ce345E0527d20B5E08f273E42886D35A5` |
| `CoachAgent` | `0x52c576686Ee095DF9C04cbFB09c6BE1A775F04e7` |

| Operation | Block | Gas | Transaction |
|---|---|---|---|
| `anchorSnapshot` | 51,230,061 | 117,025 | `0x1bd5dfe15bdc453d038daee0a8b5195d55f9a4782f8c83b24d2b0a520de76d26` |
| `mintCoach` | 51,230,106 | 168,303 | `0x86be42668921f33bdb0b9e3f33cff8aae86b8cf112b845bd7cfa5f11b4a65dde` |

`snapshotCount` reads back 1 and `ownerOf(1)` returns the owner, both from the
live chain. Deployment cost about 0.0193 0G in total.

**The product's own path is proved live too**, which matters because the checks
above used `cast` and called the contracts directly as the sender. The
application does not do that: it derives an account for the user, signs EIP-712,
and has a relayer submit and pay. `npm run test:relayed -w @ogt/og` runs that on
Galileo — a user who has never held a coin gets a record anchored (146,840 gas)
and a coach minted (200,539 gas), both owned by their derived account, paid for
by a relayer that gains no claim on either, with a replayed nonce refused by the
live contract.

The fork estimates held: 116,899 predicted against 117,025 actual, and 168,230
against 168,303. That is worth recording as evidence the fork testing was
telling the truth, not only as a gas figure.

**What only a live broadcast could show.** The first transaction after
deployment was rejected — 0G enforces a minimum 2 gwei priority fee, and `cast`
defaults to a 1 wei tip. Anvil accepted it. The application clients turned out
to be unaffected, because ethers reads the chain's own fee data and gets 4 gwei;
checking that before changing them avoided a pointless fix.

### 0G Chain — the fork harness

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

### Performance, measured rather than asserted — and re-takeable

    npm run bench -w @ogt/api

These numbers used to be measured once by hand and written down here, which made
them a claim: nobody reading them could check them, and nothing noticed when a
change turned an index scan into a sequential one. The command above seeds the
row counts, runs `EXPLAIN ANALYZE` on the queries the application issues, and
**exits non-zero if a plan has degraded**.

| Query | Scale | Plan | Time |
|---|---|---|---|
| Personal food search | 60,300 rows, 300 per user | Bitmap index scan on `user_foods_unique_idx`, top-N heapsort | 1.7 ms |
| Users due for a snapshot | 50,000 users, 49,045 with recent snapshots | Anti join, indexed on the probe side | 12.6 ms |
| Session lookup by token hash | 5,000 sessions | Index scan on `sessions_token_hash_unique` | 0.05 ms |

Run on PGlite — PostgreSQL 18 compiled to WebAssembly — so the planner is
genuine Postgres and the plan shapes are the real ones. The milliseconds belong
to whichever machine runs it and are **not** a claim about server latency. The
plan is the durable evidence; a bitmap index scan stays one on hardware.

Checked by breaking it: with index scans disabled in the planner all three
checks fail and the run exits 1, and with them enabled all three pass. A guard
that cannot fail is decoration, and this repository has shipped several of
those.

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

### Running more than one instance

Every background worker guards itself against overlapping passes with a boolean,
and that boolean lives in one process. Two API instances — the first thing that
happens when anybody scales past a single container — both walk through it.

The chain writes survive that on their own, and this is worth being precise
about because it is the part that would have been expensive to get wrong: every
chain write carries a deterministic EIP-712 nonce derived from stable data (the
snapshot's own uuid; `userId:mint`; `userId:learnedCount:evolve`), and the
contract rejects a reused one. No snapshot is anchored twice and no coach is
minted twice however many instances race.

Snapshotting did not survive it. Two instances see the same users due, both
build a snapshot, and both **pay to upload it to 0G Storage before either writes
the row** that would have revealed the duplicate. A unique index cannot help:
the money is spent before there is anything to conflict with.

Closed with a Postgres advisory lock per worker pass — no table, no migration,
and Postgres drops it when the holder dies, which a claim row would not.

| Property | How it is checked |
|---|---|
| The lock is taken and released on the same connection | Test, against a pool that hands out a distinct connection per reserve |
| A held lock is refused and the connection is not leaked | Test |
| A refused pass pays for no upload | Behavioural test against real Postgres (PGlite), counting uploads |
| Every worker consults the lock and releases it in a `finally` | Test, read from the workers' source |
| Lock ids are stable, distinct per worker, within `int8` | Test |

Checked by breaking it. Four mutations — a worker ignoring a held lock,
unlocking through the pool instead of the held connection, granting a lock
Postgres refused, and never releasing — each fail the suite; reverting each
turns it green again.

**VERIFIED against real PostgreSQL 18.4, two sessions genuinely competing.**

    DATABASE_URL=postgres://... npm run test:locks -w @ogt/api

Docker is not installed on the machine this was built on, so an embedded
PostgreSQL 18 was used instead. The first attempt died — a background worker
hit `0xC0000142`, a DLL initialisation failure in this sandbox — and the server
log named the process: autovacuum. Started with `autovacuum=off` it ran, and the
test passes:

```
ok 1 - a second instance is refused the lock the first is holding
```

It asserts a second session is refused the lock the first holds, that a
different worker's lock is unaffected, that the lock is visible in `pg_locks`,
and that releasing genuinely frees it. Checked by breaking it: granting the lock
regardless of what Postgres said, releasing without unlocking, and giving every
worker the same key each fail the test; reverting each turns it green.

Two things surfaced on the way that no fake would have shown.

The first run reported the lock refused on what looked like a fresh server, and
that was correct: `pg_locks` showed an idle `postgres.js` backend still holding
it — the previous test run, killed mid-pass, whose connection outlived the
process. `classid 3486972939` / `objid 2740220892` are exactly the two halves of
`lockKey('scheduler')`. That is the property this design was chosen for,
observed rather than asserted: the lock outlives a killed holder only as long as
its connection, and Postgres frees it without anybody cleaning up.

The second was a deadlock in the test itself, now fixed in the application too —
see the pool guard below.

Deliberately not wrapped in a transaction. A pass that threw would roll back
snapshot rows whose uploads have already been paid for and cannot roll back.

### Custody — what we can do, and what we stop being able to do

By default we hold the key. It is derived from one master seed, which is what
lets somebody who has never held a wallet own a record on chain at all. That is
standard, it is ahead of the category — mainstream nutrition apps keep this data
in plaintext — and it is not the strongest thing available.

The strongest thing available needs hardware: Signal's Secure Value Recovery and
WhatsApp's encrypted backups escrow keys inside enclaves. 0G's own ERC-7857
describes a TEE oracle that would let us do the same, and the documentation
ships a `MockOracle` with *"replace with real oracle in production"* and no
deployed address. **Building on that today would be a claim, not a mechanism.**

So this ships the shape Apple and Google actually use: recoverable by default,
real custody as an opt-in. The opt-in invents no cryptography — standard BIP-39
on the standard BIP-44 path, so the same twelve words open the same account in
any wallet.

| Property | Proved by |
|---|---|
| The master seed does not reach a self-custody key | Test, against every combination we hold |
| The phrase never reaches the server | Test asserts it appears in neither the request nor storage |
| A mismatched key and address is refused | Test — it would orphan records unrecoverably |
| Taking custody twice is refused | Test — a second key orphans the first's records |
| `ensureRecordKey` leaves their key alone | Test — the seed-drift check must not fire here |
| **The anchor worker does not sign for them** | Test, with a client that records any attempt |
| A signature from the wrong key is refused before submission | Test — the contract would revert and we would pay |
| Their device's signature anchors the record | Test — owner is theirs, relayer still pays |
| The phrase is a real BIP-39 phrase on the standard path | Test against a fixed vector and an independent wallet |
| A signature it produces verifies as its owner | Test, recomputed independently of the signer |
| The button is unreachable until the phrase is written down | Test |
| The irreversibility is stated before committing | Test |
| ethers stays lazily loaded | Test on the source; the chunk is 376 KB vs 240 KB for the app |

Checked by breaking each: fourteen mutations across the key module, the API and
the interface — including a worker that signs with the master seed anyway, a
route that skips signature verification, a button enabled before the phrase is
saved, and a static ethers import. Every one fails the suite.

**The honest limits.** The phrase is kept in the device's local storage so
anchoring can continue without prompting on every background signature — anybody
with the unlocked device can read it, which the interface says rather than
hides. Records written *before* taking custody stay under the key we held; this
applies going forward. And there is no reset: lose the words and those records
stay closed.

### Dependencies

`npm audit --omit=dev` reports **0 vulnerabilities**. Dev dependencies carry
known vite/vitest advisories; see the Known Gaps section.

---

## NOT VERIFIED

These are the honest gaps. Each says what is missing and what would close it.

### Inference on 0G Compute — VERIFIED LIVE

    npm run test:compute -w @ogt/og

Paid from our own wallet. **No API key exists anywhere in this path.** The broker
discovers providers from the on-chain marketplace, signs each request with the
wallet's key, and reports usage for settlement.

| | |
|---|---|
| Provider | `0xa48f01287233509FD694a22Bf840225062E67836` |
| Model | `qwen/qwen2.5-omni-7b` — text, image and audio in one model |
| Attestation | `TeeML` / dstack, `teeVerified: true` on chain, [verifier](https://github.com/Dstack-TEE/dstack/releases/tag/verifier-v0.5.8) |
| Price, from the chain | 1.04e12 neuron/token in, 4.18e12 out |
| Ledger | `0x0cd5e5ac…`, then deposit `0x65fb9504…`, 1.5 0G locked `0x3dc20547…` |

Three cases pass, the third being the one that matters — the product's own
`complete()`, not a hand-rolled request:

```
ok 1 - the marketplace lists providers, and the ones we would use are attested
ok 2 - a meal is read by a TEE-attested provider and the fee settles on chain
ok 3 - the product's own extraction path runs on 0G Compute
```

Measured: "one katori rajma, two rotis, half katori rice" → `{"kcal":500,
"protein_g":20,"carb_g":80,"fat_g":10}` in **5.6 s**, 49 prompt + 46 completion
tokens, 0 failovers. A second: two idlis with sambar and chutney → `{"kcal":400,
"protein_g":15}` in 4.1 s. Plausible for the cuisine, and valid JSON both times.

Two claims made on the way here were too convenient, and are recorded because
the correction is the useful part.

**"Everything already built on top works unchanged" was false.** `complete`
resolved models from the task chains, which name Router models a direct provider
has never heard of. Every attempt would have failed in a way that looks like an
outage. The chain is now overridable and the broker path supplies its own,
priced from the on-chain record.

**"Settles the fee on chain" per request was too strong.** Measured across three
consecutive calls: the locked balance stayed at 1.51 0G and the account nonce
stayed at 0, and `getAccountWithDetail` exposes no unsettled figure on our side.
The provider's own error messages carry an "unsettled fees" line, so it accounts
for usage internally and settles on its own schedule.

That is a property of the design rather than a gap in this code, and it is now
stated as one: **what we verify is that usage reporting succeeds and that the
balance locked with the provider is on chain and readable by anyone. When that
provider converts accrued usage into an on-chain deduction is not observable
from a client**, and no amount of work here would make it so.

Attestation is handled honestly rather than pretended. A direct provider returns
no `x_0g_trace`, so provenance comes from the marketplace record on chain —
established when the provider is chosen, not per response. `costNeuron` stays
`null` for the same reason: there is no authoritative charge to read, and
filling it with our own arithmetic would turn an estimate into something that
reads as accounting.

The Router path (`sk-` key) remains supported and is still the simpler
operational default.

**Adopting the wallet path costs dependency surface.** Adding
`@0glabs/0g-serving-broker` as a production dependency took this repository from
0 production advisories to 20 (18 low, 2 high) — `adm-zip`, `circomlibjs`,
`crypto-browserify`, and the ethers v5 tree with its vulnerable `elliptic`. The
adapter imports nothing from that SDK, so it is a devDependency and production
is back to **0**. An operator choosing this path takes those advisories on
knowingly.


### Contracts on the live network — CLOSED

Deployed and exercised on Galileo. See "0G Chain — DEPLOYED AND EXERCISED LIVE"
above for addresses, blocks, gas and transaction hashes.

The text below is kept for the record of what it looked like before that.

**Status when written: deployed and exercised on a fork, never broadcast.**

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

### 0G Storage round trip — CLOSED

A record has been written to 0G Storage and read back byte for byte.

| | |
|---|---|
| Root hash | `0x9455adff79014c184b4a70767cb00bc80a0e003c422b716ec0db42fb6fba4c24` |
| Transaction | `0x9a479d8d1089223eea06d5f1354c75bccde73718a77a30f2e45e66d0ff3c6f06` |
| Payload | 266 bytes, ECIES encrypted, testnet turbo indexer |

`npm run test:storage -w @ogt/og`. Three checks: the signer has funds, a record
survives the round trip identically including its Devanagari food names, and a
different key cannot decrypt it — the per-user isolation claim against a live
indexer rather than a fixture.

The text below is the record of what this looked like before.

**Status when written: not run against live storage — and, until this session,
unreachable for a second reason.**

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

### SMS delivery — the wire is verified, the vendor is not

    npm test -w @ogt/api      # tests/sms-wire.test.ts

This was recorded as unverified, and half of that was wrong. Nobody can verify a
vendor account or a DLT-approved template without having one — that part is
operational and stays open. But the sender itself had never put a single request
on a wire: every test around it stubbed `fetch` or inspected configuration, so
what a provider would actually receive was unproven, and the first person to
find out would have been the first real user who could not sign in.

It now runs against a real `node:http` server, and what arrives is read off the
socket:

| Property | Proved by |
|---|---|
| The provider receives the method, path, auth header and filled template | Real request, parsed on the server |
| A phone number containing a quote cannot become a field | Real JSON parse, not our assumption about the string |
| A rejected send raises rather than looking delivered | Real 401 |
| The one-time code never escapes in the error, even when the provider echoes it back | Real 500 carrying the code |
| A dead provider fails in seconds rather than hanging | Real refused connection |

Checked by breaking it, and one of those breaks found a defect in the test rather
than the code: the first version asserted the code never reached a logger, and
`HttpSmsConfig` has no logger, so it passed by having nothing to observe. An
inert guard is worse than no guard because it reads like one. Rewritten to assert
the realistic leak path — the thrown error, its message and its stack — and then
confirmed by attaching the echoed body to the error and watching it fail.

**Still open, and genuinely operational:** an account with an Indian SMS vendor
and a DLT-registered template. The server refuses to boot in production without
one, which is deliberate: absent, nobody can sign in while the endpoint answers
200 to every request.


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
| The core loop as a first-time user meets it | a failed reading discarded the photograph |
| My own category fixes, re-checked path by path | three journeys the accessibility work had skipped |
| My own lists, re-checked against the handlers | lab reports could be created twice, and paid for twice |
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

**Recommendation: ship custodial, described exactly as it is.**

Not because it is the stronger property — it is not — but because the
alternative costs more than it buys today. User-held keys need a recovery story
for a lost or wiped phone, and the only honest ones are a seed phrase or a
second factor. Both undo the thing that makes this product reachable at all:
sign-in is a phone number and nothing else, for people who have never used a
wallet. Trading that for a guarantee against us specifically, before there is a
single user, is the wrong order.

What makes it defensible is that nothing about it is hidden. The proof screen
says we hold the key, the schema says so, this file says so, and anybody can
take their key and read their own records without us. Four tests fail if that
disclosure is weakened.

The decision is reversible at low cost by design: the relayed path means moving
the key onto the user's device changes who calls `signAnchor` and nothing else.
No contract change, no migration.

**This is a recommendation, not a fait accompli.** If the ownership claim needs
to be absolute for the buildathon's judging, say so and the copy holds back
until keys are user-held.

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

Every claim in this file is either a command below or is marked NOT VERIFIED.
Nothing here rests on being believed.

**No network, no credentials, no funds:**

```bash
npm install
npm test --workspaces                      # 451 tests: 45 core, 91 og, 227 api, 88 web
npm run typecheck --workspaces             # four packages, strict
npm audit --omit=dev                       # 0 production vulnerabilities
cd packages/contracts && forge test        # 113 tests
npm run bench -w @ogt/api                  # query plans, fails if one degrades
```

**Reads public infrastructure, still no credentials:**

```bash
npm run evidence                           # every 0G claim, read back off 0G
```

**Needs a funded wallet in OG_STORAGE_PRIVATE_KEY:**

```bash
npm run test:compute -w @ogt/og            # inference on 0G Compute, wallet-paid
npm run test:storage -w @ogt/og            # a real record through 0G Storage
npm run test:relayed -w @ogt/og            # the relayed path on the live chain
npm run test:pipeline -w @ogt/api          # meal -> storage -> chain, end to end
npm run test:live -w @ogt/og               # the Router catalogue and pricing
npm run preflight -w @ogt/api              # check a deployment against live systems
```

**Needs a local chain or a database:**

```bash
npm run test:fork -w @ogt/og               # anchoring and coach ownership on a fork
cd packages/contracts && bash script/verify-fork.sh
DATABASE_URL=postgres://... npm run test:locks -w @ogt/api
```

The counts and commands above are checked by a test — `apps/api/tests/docs.test.ts`
— because this section had drifted before anybody noticed: it claimed 362 tests
when there were 425, 108 Foundry tests when there were 113, and omitted six
commands that existed. A hand-maintained mirror of an authoritative source is
the defect that has accounted for most of the bugs in this repository, and it
had got into the file whose entire purpose is being trustworthy.

