# It Asks

**An AI nutrition coach that never guesses a portion — it asks two questions instead.**

Built on 0G: TEE-attested inference on 0G Compute, an encrypted user-owned record on 0G Storage, and on-chain ownership of that record on 0G Chain.

---

## The problem

Every AI food app looks at a photo and guesses how much is on the plate. Measured against a kitchen scale across five frontier vision models, the error is **21% to 54%**. An independent academic measurement puts photo calorie estimation at **26.9% mean absolute error**.

The failure is specific, and it is not identification:

> *"The models always know what the food is. They just can't tell how much is on the plate. That's the whole problem."*

And the commercial consequence is asymmetric:

> *"Users forgive manual loggers for being off. They do not forgive AI."*

For Indian food it is worse. Cooking fat is invisible in a photograph and worth 100+ kcal. A thali is many dishes, not one. And the food databases are broken in a way users describe precisely:

> *"Every food item I search has over 10 similar listings in both Hindi and English, with different calories for the same item. So what should I log?"*

## What we built instead

**Rule 1: never guess an amount. Ask.**
The vision model is forbidden from committing to a quantity. It returns items, ranges, and its own confidence.

**Rule 2: at most two questions, and only when the answer moves the number by more than 10%.**
Ghee or no ghee is 100+ kcal — ask. Onion or no onion is 8 kcal — never ask. The decision is a deterministic impact calculation, not a model's judgement.

**Rule 3: every number carries its confidence.**
🟢 exact (barcode) · 🟡 confirmed (you told us) · 🔴 rough (we estimated). A guess never looks like a barcode.

**Rule 4: never ask the same question twice.**
Day one asks two questions. Day thirty asks none. **Friction falls as the record grows — this is the whole moat.**

**Rule 5: a correction is permanent.** Your dal becomes *the* entry for your dal.

**Rule 6: the user talks, we listen and remember.** One always-open chat. Sleep, stress, symptoms, travel, cycle — all of it becomes structured, permanent context.

### The measurable claim

Median questions per logged meal must fall **below 0.3 by week four**. If it stays above 0.8, the idea is wrong and the app is just a slower tracker. That number is recorded on every meal row — it is the experiment, not an analytics afterthought.

---

## Why 0G is load-bearing, not decorative

| Component | What it does here | Why it is necessary |
|---|---|---|
| **0G Compute** | All inference — meal vision, chat extraction, coaching, Hinglish speech | `qwen3-vl-30b` costs **~₹1.26 per active user per month** against **~₹87** for a frontier model on identical usage. That difference is what makes a genuinely free tier possible, which is the loudest stated demand in the Indian market. |
| **0G Compute (TEE)** | Every model touching health data is TEE-attested (Intel TDX / dstack) | Turns *"we cannot read your health data"* from a policy sentence into a hardware-attested property. Asserted at boot: the server refuses to start if any chain contains an unattested model. |
| **0G Storage** | Nightly ECIES-encrypted snapshots, addressed to the **user's own** public key | The ciphertext is addressed to them, not to us. Their record outlives this company. |
| **0G Chain** | `HealthRecordAnchor` — root hashes + revocable, index-pinned access grants | Root hashes are the retrieval key. Held in our database, "your record" is a promise; anchored on chain by the user's own address, it is a property of the system. |

**We deliberately do not use** the proxied `claude-*` / `gpt-*` models on the Router. They report `tee_attested: null` — billing convenience, not confidential execution. Identified health data must never reach them while we make the privacy claim, and a test enforces it.

**Crypto is invisible by default.** The backend holds the key and pays for inference, storage and gas. Someone can sign up with a phone number and never learn any of this is here — no wallet, no gas, no seed phrase.

**And it is theirs the moment they want it.** Self-custody is one screen: the device generates a BIP-39 phrase, derives the key, and sends us the public half. After that we can still write their records and can no longer read them or sign as them — anchoring becomes a handshake where their device signs and we still pay the gas. It is one-way on purpose. A product that can take custody back has not given anything away.

---

## Architecture

```
 PWA  (React 19 + Vite, installable, offline queue)
   │  camera-first · protein as the hero number · no score anywhere
   ▼
 API  (Fastify + Postgres)
   │
   ├─ ① SAFETY GATE ──── deterministic, pre-model, on every message
   │      red flags · ED patterns · minors · pregnancy
   │
   ├─ ② TARGETS ──────── deterministic, no LLM
   │      Mifflin-St Jeor · hard floors · capped deficits
   │
   ├─ ③ QUESTION PLANNER ─ deterministic
   │      which unknowns move the number >10%? already known? skip
   │
   ├─ ④ MODELS ───────── 0G Router, OpenAI-compatible
   │      cross-model failover · TEE-only · per-call cost recorded
   │
   └─ ⑤ RECORD ───────── Postgres (hot) → 0G Storage (encrypted)
                                        → 0G Chain (anchored)
```

### The boundary that makes cheap models safe

Open models score **32–47% on triage** and **56–80% on clinical safety** (PatientAgentBench) against 98–99% for frontier models. We use open models for cost. Therefore they are never allowed near these decisions:

| Never model-decided | How it is decided |
|---|---|
| Calorie and protein targets | Mifflin-St Jeor + floors + caps, in code |
| Whether a message is a red flag | Deterministic match, **before** any model call |
| Urgency / triage | Not done at all. Routed to a doctor |
| Which questions to ask | Deterministic >10% impact calculation |
| Final logged quantity | The user confirms it |

The model explains and extracts. **It never decides.**

---

## Repository

```
packages/core        Deterministic layer — safety, targets, question planner, confidence
packages/og          0G integration — Router client, model chains, encrypted Storage
packages/contracts   HealthRecordAnchor.sol + Foundry tests + threat model
apps/api             Fastify backend — pipelines, services, routes, snapshot job
apps/web             The PWA
```

Read `VERIFICATION.md` first if the question is whether any of this is real: every claim in this file, the command that proves it, and the ones still marked NOT VERIFIED. Then `CLAUDE.md` for the rules this was built under, `PRD.md` for what is proven versus assumed, `FEATURES.md` for the 32 ranked features, and `BUILDATHON.md` for the judging criteria.

## Current state

| | |
|---|---|
| Tests | **703 passing** — 53 core · 98 og · 279 api · 157 web · 116 contracts |
| Contract coverage | **100%** lines, statements, branches, functions |
| Typecheck | Clean across every package |
| Production audit | **0 vulnerabilities** (see `SECURITY.md`) |
| PWA first load | **75 KB** gzipped. `ethers` (141 KB) loads only if you take custody |
| Evidence | `VERIFICATION.md` — every claim above, with the command that proves it |

---

## Running it

**Prerequisites:** Node 22+, Postgres 15+, [Foundry](https://getfoundry.sh) for contracts.

```bash
git clone <repo> && cd ogt
npm install
```

### Configure

```bash
cp apps/api/.env.example apps/api/.env
```

There are two ways to pay for inference, and the app runs on either.

**Router** (default) — a hosted key. Go to [pc.0g.ai](https://pc.0g.ai), connect a wallet, deposit 0G, then Dashboard → API Keys → create a key with `inference` permission. It starts with `sk-`.

```
DATABASE_URL=postgres://localhost:5432/ogt
OG_INFERENCE_MODE=router
OG_ROUTER_API_KEY=sk-...
OG_STORAGE_PRIVATE_KEY=0x...     # backend key that pays for storage writes
OG_NETWORK=testnet
```

**Broker** — no API key at all. The wallet pays each provider directly through
`@0glabs/0g-serving-broker`, settled on chain. Set the mode and drop the key:

```
OG_INFERENCE_MODE=broker
```

The marketplace requires a **1 0G minimum** in the ledger before a provider will
answer, and funding it is `transferFund` *after* `addLedger` — skipping that
step returns a "requires 1 0G" error that reads like an empty balance when the
balance is fine. `npm run test:compute -w @ogt/api` runs a live call on this
path and prints what it cost.

### Run

```bash
npm run db:migrate -w @ogt/api
npm run dev -w @ogt/api          # http://localhost:8080
npm run dev -w @ogt/web          # http://localhost:5173
```

### Contracts

```bash
cd packages/contracts
forge test
forge coverage
forge script script/Deploy.s.sol:Deploy --rpc-url og_testnet --broadcast
```

### Verify everything

```bash
npm test --workspaces      # 587 tests
npm run typecheck --workspaces
npm audit --omit=dev
npm run evidence           # checks every 0G claim against 0G itself, live
```

`npm run evidence` needs no key, no funds and no configuration — it reads public
0G infrastructure and prints a pass or fail per claim, so anybody can run it
without being trusted with anything.

## Network reference

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| 0G Galileo testnet | **16602** | `https://evmrpc-testnet.0g.ai` | `chainscan-galileo.0g.ai` |
| 0G Mainnet | **16661** | `https://evmrpc.0g.ai` | `chainscan.0g.ai` |

⚠️ Some older 0G docs and deployment scripts say **16601** for Galileo. The canonical value in `0g-doc/docs/ai-context.md` is **16602**.

Contracts compile with `evmVersion = "cancun"`, warnings treated as errors.

---

## Safety and honesty

This is a **wellness product**, not a medical device. It does not diagnose, treat, cure, prevent, or monitor any disease.

- Hard calorie floors: **1200 kcal female / 1500 kcal male**, regardless of what a user asks for
- Maximum 25% deficit, maximum 0.75 kg/week
- Under-18 → refused. BMI under 17.5 requesting a cut → refused, offered help to gain instead
- Purging, laxative, or starvation language → stop, do not coach, surface **Tele-MANAS 14416**
- Chest pain, fainting, bleeding → deterministic match before any model, routed to a doctor
- Safety events are logged **by reason code only** — never the message text

The safety layer is plain code, not prompt text. It is not persuadable, and a test asserts that no route can reach a model without passing through it first.

## What is not verified

Stated plainly, because the alternative is a claim we cannot support:

1. **Whether these models can read an Indian thali or lab report accurately.** The cost case rests on it. Untested.
2. **Whether two questions read as trust or as friction.** The thesis rests on it. Only measurable with real users.
3. **Whether question count actually decays in practice.** Instrumented, not yet observed.
4. **Whether Indians will pay ₹199–299** for this.
5. **Whether structure beats free** — ChatGPT is the real competitor and it costs nothing.

`PRD.md` §17 lists what would falsify each, and §19 sets the gates that stop the project if they do.

Not reviewed by a clinician, an Indian lawyer, or a single real user. All three are required before launch.
