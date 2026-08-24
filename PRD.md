# PRD — Product Requirements Document

**Working name:** TBD
**Platform:** PWA (installable, offline-capable)
**Market:** India-first
**Infrastructure:** 0G Compute (Router) + 0G Storage
**Version:** 0.1 — draft for review
**Date:** 24 August 2026

---

## 0. HOW TO READ THIS DOCUMENT

This PRD does **not** claim to be optimal, complete, or production-ready. It claims to be *falsifiable*.

Three conventions are used throughout:

| Tag | Meaning |
|---|---|
| **PROVEN** | Traces to a named source in `INDEX.md` / `FINDINGS-*.md`, with the source stated |
| **NOT VERIFIED** | Assumption, estimate, or single-sourced claim. Must be tested before it is depended on |
| **KILLS THIS** | A specific observable result that would invalidate the decision above it |

Section 17 lists every way this product could be wrong. Section 6 defines the numbers that decide whether it is working. **If Section 6's gates fail, the correct action is to stop, not to iterate.**

Sources of record: `FEATURES.md` (32 features), `INDEX.md` (research master), `oglabs resources/` (0G technical).

---

## 1. THE PROBLEM

Three problems stack on top of each other. Each is separately evidenced.

### 1.1 AI food tracking is confidently wrong, and users punish that specifically

Vision models identify food correctly and estimate quantity badly. Measured across five models against a kitchen scale:

| Model | Mean error |
|---|---|
| Gemini 3.1 Flash-Lite | ~21% |
| Gemini 3.5 Flash | ~29% |
| GPT-5.5 | ~38% |
| Qwen 3.7 | ~51% |
| Grok 4.3 | ~54% |

> *"The models always know what the food is. They just can't tell how much is on the plate. That's the whole problem."*

An independent academic measurement puts photo calorie estimation at **26.9% mean absolute error** across 16 nutrients (Nutrients, 2025).

The commercial consequence is asymmetric and specific:

> *"Users forgive manual loggers for being off. They do not forgive AI. If the AI says a pizza is 200 calories, trust evaporates instantly."* **NOT VERIFIED** — third-party review scrape, self-promotional source. But it is corroborated by the Cal AI review revolt (*"Being 200kcal off is the gap between a healthy calorie deficit and staying the same weight"*, 519 likes).

**PROVEN.** The failure is quantity estimation, not identification.

### 1.2 Indian food is not served by any existing tool

> *"Every food item I search has multiple (sometimes over 10) similar listings with similar names in both Hindi and English, and mostly different calories for the same item. **No tech to map synonyms or names in different languages.** … So what should I log? Big confusion every time. A senior product manager is needed here."* — 1★ Healthify India

> *"Searched 'dal tadka' and got 6 different entries with wildly different calories. Searched 'poha' and half the entries don't even have protein data."*

And the objection nobody in that thread could answer:
> *"How do you intend to track dal tadka or roti with ghee or roti without ghee? What if someone added more oil?"*

Meanwhile MyFitnessPal's own India storefront reviews say: *"Less accuracy for indian food. May be indian market or customers arent priority right now."*

**PROVEN.**

### 1.3 The demand is enormous, proven, and currently served badly by general chatbots

- **230M people/week** ask ChatGPT health questions; >5% of all its messages (OpenAI, Jan 2026)
- **32% of US adults** used AI for health advice in the past year (KFF, n=1,343, ±3pp) — independently corroborated by Rock Health at the same 32%
- **33% of Indian respondents** use AI chatbots for general health advice
- In India, the manual version of this job draws millions: Hindi videos explaining medical reports pull **2.2M / 1.05M / 903K views**. The best AI-native equivalent found: **706 views**
- Indian calorie-math explainer videos: **836K / 436K / 317K views.** Indian-food AI calorie startups: **13 / 14 / 184 / 806 views**

**PROVEN.** Demand is established. Supply has no distribution.

---

## 2. WHO THIS IS FOR

### Primary user — v1

**Urban / tier-2 Indian, 18–35, smartphone-first, wants to lose or gain weight, eats mostly Indian home or mess food, owns no wearable.**

Specific characteristics that drive design decisions:
- Eats food that is **composite and unweighable** (thali, sabzi, mess plate)
- Cooking fat varies dish to dish and household to household
- Comfortable in Hinglish; may prefer voice over typing
- Has been burned by a health app before (see §1.2, and the ₹3-trial auto-debit pattern)
- Price sensitivity is real: **D35 download-to-paid is 2.56% in North America vs 1.37% in India/SEA**

### Explicitly NOT for v1

| Excluded | Why |
|---|---|
| Wearable-first users | Whoop, Oura, Google, Apple own that data and are shipping coaches on it |
| Users seeking diagnosis | Triage is the least-solved capability in the field (§13) |
| US market | Google Health Coach + ChatGPT Health occupy that slot with free tiers and vastly better distribution |
| Under-18 | Hard refusal (§13.2) |
| Clinical / B2B | Different product, different regulatory posture |

---

## 3. WHY NOW

**The window is real but narrow, and it is narrowing.**

- Google Health Coach ships **medical records — lab results, medications, visit history via b.well + CLEAR — next month. US only.**
- ChatGPT Health launched 7 Jan 2026, uses **the same b.well pipe**. US-first.
- Apple **shelved** its AI health coach (Project Mulberry, Feb 2026)
- The single most repeated request in every one of their comment sections: **"make it available outside the US"** — with India named explicitly and repeatedly

**PROVEN.** The generic coach slot is closing in the US within weeks. It is not closing in India, and nothing shipping addresses Indian food, Hinglish, household eating, or the no-wearable majority.

**KILLS THIS:** Google or OpenAI shipping India-localised health coaching with an Indian food database inside 12 months. Monitor quarterly. This is the single largest strategic risk and it is outside our control.

---

## 4. THE THESIS AND THE RULES

**Thesis:** *It asks. It doesn't guess.*

Two questions beat a confident guess, because the failure mode of a guess is lost trust and the failure mode of a question is two seconds.

The six rules from `FEATURES.md` Tier 0 are **product constitution**. They outrank every feature. When a feature conflicts with a rule, the rule wins.

| | Rule | Enforced by |
|---|---|---|
| R1 | Never guess an amount. Ask. | Vision prompt returns items + confidence, never a committed quantity |
| R2 | Max 2 questions, only if the answer moves the number >10% | Deterministic impact calculator decides which questions to ask |
| R3 | Every number carries visible confidence | 🟢 exact / 🟡 confirmed / 🔴 rough on every entry and daily total |
| R4 | Never ask the same question twice | Personal food library keyed to user + dish |
| R5 | A correction is permanent | Corrections write to the user's own food entries |
| R6 | The user talks, we listen and remember, always | Life chat → structured extraction → permanent record |

**The measurable expression of R4 is the most important number in this product.** See §6.2.

---

## 5. SCOPE

### 5.1 In scope for v1

From `FEATURES.md` Tier 1 (all nine, non-negotiable) plus the two safety features:

| # | Feature |
|---|---|
| 01 | Photo → identify → ask amount → log |
| 02 | Life chat — tell it anything |
| 03 | Proactive asking (rate-limited, see §9.4) |
| 04 | Confidence labels |
| 05 | "Your usual?" one-tap |
| 06 | Protein as hero number |
| 07 | Hinglish typed or spoken |
| 08 | Personal food library |
| 09 | Genuinely usable free tier |
| 24 | Hard red-flag routing |
| 25 | ED guardrails and calorie floors |

**24 and 25 ship before a single external user.** They are not features; they are preconditions.

### 5.2 Explicitly out of scope for v1

Tier 2–4 (`FEATURES.md` 10–23, 26–32). Blood report reading (16) is the highest-value deferred item and is the natural v2 wedge — but it depends on Indian OCR accuracy which is **NOT VERIFIED**.

### 5.3 Permanently refused

A single wellness score · a generic AI health coach · wearable dependency · a symptom checker · silent guessing · Reddit/community marketing · any diagnose-or-treat claim.

Each has a documented failure attached in `FEATURES.md`.

---

## 6. SUCCESS CRITERIA

Per the quality standard: claims of "working" require measurable criteria defined **before** the work, and evaluation against them afterwards.

### 6.1 Gate metrics — these decide whether the product continues

| Metric | Target | Why this number | If it fails |
|---|---|---|---|
| **Activation:** ≥3 logs in first 14 days | ≥55% of installs | <3 sessions in 14 days predicts **3–4× churn** (PROVEN) | Onboarding or friction is wrong. Fix before spending on acquisition |
| **Time to first logged meal** | <90 s from first open | First-session value is the strongest lever available | Cut onboarding questions |
| **D30 retention** | ≥20% | See conflict note below | Product is not habit-forming. Stop and diagnose |
| **Red-flag recall** | **100%** on a fixed 200-case test set | Non-negotiable safety floor | Do not ship |
| **Cost per active user** | <₹8/month all-in AI | Keeps free tier viable at Indian pricing | Re-tier models |

**D30 conflict, stated openly:** published health-app D30 benchmarks disagree by roughly 5× — AppsFlyer 2.78%, Statista 3.4–4%, vendor analytics blogs 15–25%, "best apps 40%+". These use different denominators (installs vs registered vs paying). **20% is an internally-chosen target against registered users, not a benchmark-matched claim.** **NOT VERIFIED** that it is achievable.

### 6.2 The thesis metric — question decay

This is the number that proves the core idea works. Nothing else in this PRD matters if this fails.

| Week | Median questions asked per logged meal | Interpretation |
|---|---|---|
| 1 | 1.5 – 2.0 | Expected. The app is learning |
| 2 | ~1.0 | Learning is working |
| 4 | **< 0.3** | R4 is real. The moat exists |
| 8 | < 0.15 | Compounding |

**KILLS THIS:** if median questions per meal is still >0.8 at week 4, R4 is false. The app is then simply *slower* than Cal AI with no compensating benefit, and the thesis is dead. **This is the single most important measurement in the project.**

### 6.3 Quality metrics

| Metric | Target | Note |
|---|---|---|
| Photo → result latency (p95) | <3 s | Speed is a feature |
| % of daily totals at 🟡 or better | ≥80% by week 2 | Measures whether asking actually works |
| Correction rate (entries edited after logging) | Declining week over week | If flat, R5 is not learning |
| Abandonment at the question step | <10% | **If high, R2 is too aggressive — questions are friction, not trust** |
| Proactive message → reply rate | ≥25% | Below this, feature 03 is spam. Reduce frequency |
| "Ask me less" opt-outs | <5% of users | Above this, 03 is actively harming |

### 6.4 Business metrics

| Metric | Target | Note |
|---|---|---|
| Free → paid conversion | 3–5% | Category median trial conversion is 6.9%, but that is trial-to-paid, not free-to-paid, and is US-weighted. **NOT VERIFIED** for India |
| Gross margin per paying user | >85% | Achievable at 0G pricing; not at frontier-model pricing |
| Refund / chargeback rate | <2% | Direct test of whether §16.2 pricing honesty works |

---

## 7. USER JOURNEYS

### 7.1 First run — target under 90 seconds

1. **Open.** No signup wall. Camera is the first screen.
2. **Goal:** lose / gain / maintain — one tap
3. **Basics:** sex, age, height, weight — four fields, prefilled sensibly
4. **Diet:** veg / non-veg / egg — one tap
5. **Who cooks:** self / family / mess / tiffin — one tap *(this question is not asked by any competitor and drives most later personalisation)*
6. **First photo.** Ask up to two questions. Show the result with its confidence label.
7. **Then** offer account creation, to save it.

**Design rule:** the user sees a real, personal number before being asked for anything they'd hesitate to give.

### 7.2 The daily loop

```
meal time  →  open (camera ready)  →  photo
           →  [0–2 questions, shrinking over weeks]
           →  number + confidence + protein remaining
           →  close
```

Target: **under 15 seconds by week 4.** Under 30 seconds on day 1.

### 7.3 The life chat loop (feature 02)

The user types or speaks anything, any time. Extraction is silent. The app never demands input.

```
"slept badly, maybe 5 hours"      → sleep record
"gym today, legs, felt weak"      → workout + subjective energy
"skipped lunch, chai and biscuits" → meal + a gap flagged
"stomach's been off 3 days"        → symptom, dated, followed up once
"travelling Thursday, hostel food" → forward context for next week
```

Everything lands in one permanent, timestamped record. **This is what makes §7.4 possible and what every shipped competitor fails at:**

> *"Whoop AI coach can't read its own sets, reps and weight data… it said I needed to type all this information manually into the prompt."*

### 7.4 The payoff moment

The user asks — or the app notices — and gets an answer no competitor can give, because no competitor has the record:

> *"Why have I been low on energy this week?"*
> "Three things line up. You averaged 5h40m sleep against your usual 7h. Protein dropped to 58g/day from 95g. And you moved dinner to after 10pm on the four days you felt worst. **The sleep drop is the strongest pattern.** These are observations from your log, not a diagnosis."

**Constraint:** always framed as patterns, never causation. Never a diagnosis. If a medical explanation is plausible, route to §13.1.

---

## 8. SYSTEM ARCHITECTURE

```
 PWA (React + Vite, installable, offline queue)
        │  HTTPS
 ┌──────▼──────────────────────────────────────────────┐
 │  Backend (Node/TS)                                   │
 │                                                      │
 │  ① SAFETY GATE  ── deterministic, pre-model, always  │
 │       red flags · ED patterns · minor · pregnancy    │
 │                                                      │
 │  ② TARGETS ENGINE ── deterministic, no LLM           │
 │       Mifflin-St Jeor · floors · caps · macro split  │
 │                                                      │
 │  ③ QUESTION PLANNER ── deterministic                 │
 │       which unknowns move the number >10%?           │
 │       already known for this user? → skip (R4)       │
 │                                                      │
 │  ④ MODEL LAYER ── 0G Router, OpenAI-compatible       │
 │       vision · extraction · coaching · speech        │
 │                                                      │
 │  ⑤ RECORD  ── Postgres (hot) → 0G Storage (durable)  │
 └──────────────────────────────────────────────────────┘
```

**Non-negotiable separations:**

- **The safety gate runs before any model call.** Every inbound message. No exceptions.
- **The targets engine never calls an LLM.** Calorie and protein targets drive what we tell people to eat daily; they must be reproducible and auditable.
- **The question planner is deterministic.** Which two questions to ask is a calculation, not a model judgement.
- **The model explains and extracts. It never decides the plan.**

This separation is not stylistic. It is what makes §13 enforceable and what lets us use a cheap model without inheriting its safety profile — open models score **32–47% pass on triage** and **56–80% on clinical safety** versus 98–99% for frontier models (PatientAgentBench). **We do not let them near those decisions.**

---

## 9. AI LAYER SPECIFICATION

### 9.1 Model routing

All calls via **0G Router** — `https://router-api.0g.ai/v1`, OpenAI-compatible, `Authorization: Bearer sk-…`.

| Task | Primary | Fallback 1 | Fallback 2 |
|---|---|---|---|
| Meal photo → items + confidence | `qwen3-vl-30b` | `0gm-1.0-35b-a3b` | `qwen3.7-plus` |
| Life-chat extraction | `qwen3.7-plus` | `qwen3.8-max` | `kimi-k3` |
| Coaching / weekly synthesis | `qwen3.7-plus` | `qwen3.8-max` | `kimi-k3` |
| Hinglish speech → text | `whisper-large-v3` | — | — |

**Every model in these chains is TEE-attested (Intel TDX via dstack).** This is a product commitment, not an optimisation — see §14.

⚠️ `claude-*` and `gpt-*` on the Router report **`tee_attested: null`** — they are proxied to the original provider. Convenient billing, **not** a privacy guarantee. **They must never receive identified health data** while we make the §14 claim.

⚠️ Most models list **1–2 providers**. The Router fails over *within* a model's provider set, so a single-provider model is a single point of failure. The chains above exist for this reason and are not optional.

### 9.2 Cost model

Per active user per month, assuming 90 photo logs + 60 chat turns:

| Model | ₹/user/month | Margin at ₹299 |
|---|---|---|
| `qwen3-vl-30b` | **₹1.26** | 99.6% |
| `0gm-1.0-35b-a3b` | ₹3.99 | 98.8% |
| `claude-sonnet-5` | ₹87.03 | 70.9% |
| `claude-opus-5` | ₹229.02 | 23.5% |

**This is the entire economic case for building on 0G.** Feature 09 — a genuinely usable free tier, the loudest stated Indian demand — is affordable at ₹1.26 and is not affordable at ₹87.

**NOT VERIFIED:** these are modelled from published per-token pricing against estimated usage. Real image token counts and cache behaviour will differ. Re-measure after 100 real users.

### 9.3 The vision contract

The model is **forbidden from committing to a quantity.** It returns:

```
items[]:  name · likely portion range · grams estimate ·
          per-100g macros · confidence 0–1 · ambiguities[]
```

The **question planner** (deterministic) then decides what to ask, by computing which unknown moves the calorie or protein total by more than 10%:

| Unknown | Typical impact | Ask? |
|---|---|---|
| Portion count (1 vs 2 katori) | 100–250 kcal | **Always, if unknown** |
| Cooking fat (ghee / oil / dry) | 90–150 kcal | **Always for Indian gravies and roti, if unknown** |
| Paneer vs tofu vs soya | 40–90 kcal, large protein delta | Ask if confidence <0.6 |
| Dal thickness (whole vs watered) | 30–70 kcal, protein delta | Ask if confidence <0.6 |
| Onion / garnish / salad | <20 kcal | **Never** |

Cap: **two questions.** If more than two unknowns exceed threshold, ask the two with the largest impact and mark the entry 🔴.

### 9.4 Proactive messaging (feature 03) — hard limits

The easiest feature on this list to ruin. Limits are enforced in code, not prompt:

- **Maximum one proactive message per 24 hours. Absolute.**
- Only on a specific, personal trigger. **Never** "Don't forget to log!"
- Never between 22:00 and 07:00 local
- One tap → "ask me less" → obeyed permanently, no re-prompt
- **A resolved topic is never re-raised.** Resolved state is stored explicitly

This last rule exists because of a specific documented harm:
> *"3 months later. It keeps telling me I need to modify my activities for my foot pain. I told it to stop, it said it would erase that info, and it's there again… it began to gaslight me… I worry that someone who is more suggestible could actually be psychologically hurt by the passive aggressive AI."*

### 9.5 Tone

Default **Straight**. Never sycophantic at any setting.
> *"LLMs are yes men."* · *"the coach shouldn't be so sycophantic"* · *"prompt him to be more contentious using logic and science"* (253 likes)

---

## 10. DATA MODEL — critical decisions

Three decisions must be made now because retrofitting them is expensive.

### 10.1 Household is first-class, not a setting
One cook, several eaters, one grocery list, separate targets.
> *"How add other persons like my husband's and daughter's profile?"* — Indian app review

Acara Plate (shipping open-source health agent) treats `UpdateHouseholdContext` as a **tool**, not a preference. **PROVEN** by convergence.

### 10.2 Cooking fat is a property of every dish
`cooking_fat: {none | oil | ghee | butter}` + `quantity_tsp`, with a household default set once. Roti-with-ghee and roti-without are **different foods**, not one food with a note.

### 10.3 The personal food entry supersedes the global database
On correction, we do not edit a shared record. We create the user's own. `user_food_entry` always wins over `global_food` in search ranking for that user. **This is R5 in schema form and it is the compounding moat.**

### 10.4 Storage split

| Layer | Contents | Why |
|---|---|---|
| **Postgres (hot)** | everything, live | UX must never block on chain or object storage |
| **0G Storage (durable)** | nightly ECIES-encrypted snapshot | user-owned, portable, survives us |

**Never write per-meal to 0G Storage** — cost and latency. **Root hashes are the retrieval key; lose them and the data is unreachable.** They are stored in Postgres and included in every export.

---

## 11. PWA REQUIREMENTS

| Requirement | Target | Reason |
|---|---|---|
| Installable, home-screen icon | Yes | App-store install friction is the #1 killer of Indian consumer health apps |
| Cold open → camera ready | <2 s | Speed is a retention feature |
| Offline logging with sync queue | Required | Indian mobile networks are not reliable; a lost log is a lost habit |
| Mid-range Android (4GB RAM) | Must be smooth | *"crashes under cellular data"*, *"app is heating up my iphone"* are real reviews of competitors |
| Bundle size | Aggressively small | Same reason |
| Dark mode | Yes | Table stakes |
| Push notifications | Required | Notification opt-out predicts 3–4× churn — so they must be *correct*, not frequent |

**NOT VERIFIED:** iOS PWA push support and install UX are materially worse than Android. If the primary user is on iOS, this platform decision needs revisiting. Measure the actual device split in the first cohort.

---

## 12. WHAT WE DO NOT ASK THE MODEL TO DO

Explicit list, because this is where health AI products fail:

| Never | Instead |
|---|---|
| Decide calorie or protein targets | Deterministic Mifflin-St Jeor + floors + caps |
| Decide whether a message is a red flag | Deterministic pattern match, pre-model |
| Assess urgency or triage | Route to a doctor. Triage is the weakest measured capability of every model tested |
| Commit to a quantity from a photo | Return a range + confidence; ask the user |
| Diagnose, name a condition, or interpret a result clinically | Explain what a marker measures; route to a doctor |
| Override a safety floor because the user insisted | Refuse. The safety layer is not persuadable |

---

## 13. SAFETY — PRECONDITIONS, NOT FEATURES

### 13.1 Medical red flags
Deterministic match **before any model call**: chest pain, fainting, blood in stool/urine/vomit, can't breathe, sudden unexplained weight loss.
→ Immediate, non-model, fixed response routing to a doctor.

Justification: PatientAgentBench measures **triage as the weakest dimension for every model** — 76–88% pass for frontier, **32–47% for open models**. We use open models. Therefore we do not let them triage.

This also addresses the specific Indian fear, which is the inverse of the Western one:
> *"it could tell you a heart attack is just gas pain"*

### 13.2 Eating-disorder guardrails
- Hard calorie floors: **1200 kcal female / 1500 kcal male**, regardless of user request
- Maximum deficit 25% of TDEE; maximum pace 0.75 kg/week
- Under-18 → **refuse and route out**
- BMI <17.5 requesting a cut → **refuse, offer to help gain instead**
- Purging / laxative / starvation language → **stop, do not coach, surface Tele-MANAS 14416**
- Pregnancy / breastfeeding → route to clinical care

Deterministic. Not prompt text. **Must not be persuadable.**

Justification: Yara's founder voluntarily shut down an AI therapy app as too dangerous. Illinois ($10,000/violation) and Nevada ($15,000/violation) now penalise unlicensed AI mental-health care.

### 13.3 Regulatory positioning
Target the **FDA general-wellness safe harbour** posture as a design discipline, and mirror Google's own disclaimer language:

> *"Not intended to diagnose, treat, cure, prevent, or monitor any disease."*

**The line, from the Whoop precedent:** measuring a **diagnosable parameter** makes it a medical device *regardless of "wellness" framing*. Whoop's warning letter (Jul 2025) was closed (Jun 2026) after product and labeling changes — **but it anchored a class action in the meantime.** Regulatory exposure creates litigation exposure even after the regulator stands down.

**India:** DPDP Act 2023 + Rules 2025 — health data is among the most sensitive categories; **purpose limitation** means data collected for coaching cannot be reused for marketing without separate explicit consent. **CDSCO's draft SaMD guidance (Oct 2025) is still not finalised — this is the key open regulatory unknown. NOT VERIFIED.**

**Required action:** an Indian legal review before public launch. This PRD is not a legal opinion.

---

## 14. PRIVACY AND DATA OWNERSHIP

**77% of adults report concern about medical data privacy.** The top comment on OpenAI's own ChatGPT Health launch video is a privacy objection (281 likes). Self-builders are hand-rolling local Ollama stacks specifically to avoid uploading health data.

Commitments:

1. **All identified health data is processed on TEE-attested models only.** Hardware-attested confidential execution, not a policy sentence.
2. **The durable record is ECIES-encrypted on 0G Storage** — the user's, portable, survives the company.
3. **Export everything, free, forever** — CSV + PDF, whether or not they are paying.
   > *"Once you stop your subscription you lose your data. Wow that's an automatic no from me."* (387 likes)
4. **Never sold, never used for ads, never used to train third-party models.**
5. **Crypto is invisible.** Backend holds the 0G key and funds the Router balance. Users sign in with phone or Google. **No wallet, no gas, no seed phrase — ever.** Wallet friction is the primary killer of consumer crypto apps.

**Marketing constraint:** we say *privacy*, never *blockchain*. The user cares that nobody can read their data. They do not care how.

---

## 15. INSTRUMENTATION

Without these, §6 cannot be evaluated and the project flies blind.

- **Funnel:** install → first photo → first log → D1 → D7 → D14 → D30
- **Questions asked per log, per user, per week** — the §6.2 thesis metric. Instrument this first
- **Abandonment at the question step** — the counter-metric that would prove R2 is friction
- **Every AI suggestion + whether it was followed** — the real moat dataset
- **Correction events** (what, from what, to what) — feeds R5 and measures learning
- **Confidence mix** of daily totals over time
- **Proactive message → reply rate, and "ask me less" rate**
- **Per-user AI cost**, so free-tier viability is observable not assumed
- **Safety gate fires**, by reason code, **never with message text**
- Thumbs up/down on every coach reply

---

## 16. PRICING

### 16.1 Structure

| Tier | Price | Contents |
|---|---|---|
| **Free, forever** | ₹0 | Unlimited photo + text + voice logging · life chat · targets · personal food library · export |
| **Paid** | ₹199–299/mo | Coach depth · "what should I eat now" · weekly review · ask-your-data · household profiles |
| **Annual** | ~₹1,999 | Discount; annual plans are 68% of category revenue |

Free is genuinely usable because at **₹1.26/user/month** it can be. This is the direct product consequence of the 0G decision.

**NOT VERIFIED:** the ₹199–299 price point. Indian willingness to pay for this specific product is untested. Test in the concierge phase before building billing.

### 16.2 Pricing honesty as a differentiator

**No auto-renew. No ₹3 trial. No card before value. One-tap cancel inside the app. Zero sales calls — stated in writing on the pricing page.**

This is not ethics theatre; it is the cheapest available differentiator in this specific market:
> *"3 rs trial ke liye pay kiya… 3 days ke baad 499 mere cut gye"*
> *"1 mahine mein 6 baar money deduct kar li. Total 1794"*
> *"I used to get 15 to 20 calls each day after installing this app"*
> *"Rude dietitian… The call traumatised me."*

Every Indian entrant inherits this suspicion. Refusing the dark pattern loudly is a positioning asset.

---

## 17. RISKS AND FALSIFICATION

Per the quality standard: actively try to break this before believing it.

### R1 — The vision model cannot read Indian food ⚠️ HIGHEST
The entire cost case rests on `qwen3-vl-30b` being adequate on thali, mess plates, and gravies. **NOT VERIFIED.**
**Test:** 30–50 real photos, phone camera, real lighting, graded against a kitchen scale, compared against a frontier control.
**Kills this if:** identification (not quantity) is unreliable, since the whole design assumes identification is the *solved* half.
**Mitigation if it fails:** two-tier — cheap model for common dishes, stronger model on low confidence. Margin drops; product survives.

### R2 — Questions are friction, not trust
The thesis assumes 2 questions build trust. They may simply annoy.
> *"The moment I have to think, my adherence collapses."*
**Test:** §6.3 abandonment-at-question-step. **Kills this if >10%.**
**This is the thesis risk. It cannot be reasoned away — only measured.**

### R3 — Question decay doesn't happen
If median questions per meal is still >0.8 at week 4, R4 is false and we are a slower Cal AI with no upside. See §6.2.

### R4 — ChatGPT is the real competitor, and it is free
Honest assessment: users are already doing this in ChatGPT, at scale, for free, on better models.
Our answer must be *structure and memory*, not intelligence: ChatGPT does not keep a queryable food log, does not compute protein remaining today, does not know your kitchen, and makes you re-explain yourself.
> *"Everything your App does apart from massively annoying users, gemini and chatgpt can do better for free."*
**NOT VERIFIED** that structure beats free. This is a genuine strategic risk, not a solved one.

### R5 — 0G availability
Most models have 1–2 providers. Chains (§9.1) mitigate but do not eliminate. Only 15 repos on GitHub use 0G storage; the ecosystem is small and immature. **Have a non-0G emergency fallback path designed, even if unused.**

### R6 — Distribution
The obvious channel is closed: r/diabetes permanently bans app posts and "AI stories"; r/loseit calls AI-app recruiters predatory. Plan around it — content and word of mouth, not community posting.

### R7 — Free tier cannibalises paid
If free is genuinely good, why pay? The bet is that coaching depth and ask-your-data are worth ₹199. **NOT VERIFIED.** Watch conversion from week one.

### R8 — Platform risk
Google or OpenAI shipping India-localised health coaching with Indian food data closes the wedge. Outside our control. Monitor quarterly.

### Honest comparison against alternatives

| Alternative | Their advantage | Our answer | Honest weakness |
|---|---|---|---|
| **ChatGPT** | Free, better models, already used by 230M/week | Structure, memory, protein-first, no re-explaining | They may add memory + health structure. R4 |
| **Cal AI** | 15M downloads, proven mechanic, fast | We're accurate and honest about uncertainty | We are *slower per log*. That is a real cost |
| **HealthifyMe** | 40M users, Indian food DB, coaches | Cheaper, honest pricing, no sales calls, better AI | They have a 10-year data and distribution head start |
| **Google Health Coach** | Gemini, distribution, wearables, medical records | Not in India, no Indian food, needs a wearable | If they localise, our wedge closes. R8 |

---

## 18. OPEN QUESTIONS

Must be answered before or during the phase noted.

| # | Question | Blocks | Phase |
|---|---|---|---|
| 1 | Can TEE models read Indian meals accurately? | Everything | 0 |
| 2 | Do 2 questions read as trust or friction? | The thesis | 1 |
| 3 | What is the real per-user AI cost at 100 users? | Free-tier viability | 2 |
| 4 | iOS vs Android split in the first cohort? | PWA vs native | 1 |
| 5 | Will Indians pay ₹199–299 for this? | Pricing | 1 |
| 6 | Indian legal position on lifestyle coaching claims? | Public launch | 2 |
| 7 | Can we read Indian lab report PDFs? | v2 (feature 16) | 3 |
| 8 | Name and brand? | Launch | 2 |

---

## 19. MILESTONES AND GATES

Each gate is a stop condition, not a checkpoint.

**Phase 0 — Kill or confirm (week 1)**
Run the vision benchmark. Talk to 20 target users.
**GATE:** identification reliable on Indian food AND quantity questions feel reasonable to 15/20 people. *Either fails → stop and reconsider.*

**Phase 1 — Concierge (weeks 2–5)**
No app. 20 real users on WhatsApp. You are the coach, AI-assisted, reading every message before it sends.
**GATE:** 12/20 still logging at week 4, and ≥5 say unprompted they'd pay.

**Phase 2 — v1 PWA (weeks 6–12)**
Tier 1 (01–09) + safety (24, 25). Nothing else.
**GATE:** activation ≥55%, **question decay <0.3 by week 4**, D30 ≥20%.

**Phase 3 — Trust and depth (weeks 13–20)**
Tier 3 trust features (18–23, 26), then Tier 2 retention.
**GATE:** free→paid ≥3%, refunds <2%.

**Phase 4 — Blood reports (v2)**
Feature 16 + 17, gated on open question 7.

---

## 20. APPENDIX — 0G TECHNICAL REFERENCE

Verified against `oglabs resources/0g-doc/docs/ai-context.md` and the live Router API.

**Compute — Router (what we use)**
- Endpoint: `https://router-api.0g.ai/v1` — OpenAI-compatible
- Auth: `Authorization: Bearer sk-…`
- Keys created at **pc.0g.ai → Dashboard → API Keys** (deposit 0G tokens first)
- `sk-` = inference (billed) · `mk-` = management, balance, key rotation (not billed)
- `sk-` keys **cannot** read `/v1/account/*` — use `mk-` for balance monitoring
- Router handles provider failover automatically **within a model**; cross-model chains are ours (§9.1)
- Model catalogue: `GET /v1/models` — no auth required

**Note:** the "always call `processResponse()`" and `ZG-Res-Key` header rules in the resources guide apply to **Direct SDK mode** (`@0gfoundation/0g-compute-ts-sdk`), not Router mode. We use Router. Do not mix the two mental models.

**Storage**
- Package: `@0gfoundation/0g-storage-ts-sdk` (with `ethers` v6)
- Testnet indexer: `https://indexer-storage-testnet-turbo.0g.ai`
- Mainnet indexer: `https://indexer-storage-turbo.0g.ai`
- Flow contract is resolved internally by the Indexer for file uploads; only needed explicitly for KV `Batcher`
- **Root hashes are the retrieval key. Lose them, lose the data.**
- Close `ZgFile` handles.

**Chain**
| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Galileo testnet | **16602** | `https://evmrpc-testnet.0g.ai` (dev only) | `https://chainscan-galileo.0g.ai` |
| Mainnet | **16661** | `https://evmrpc.0g.ai` | `https://chainscan.0g.ai` |

⚠️ Some older docs and deployment scripts say **16601** for Galileo. The canonical AI-context file says **16602**. Verify before deploying.
- Use third-party RPCs (Ankr, dRPC) in production, not the public dev endpoint
- Compile contracts with `evmVersion: "cancun"`; ethers **v6** syntax

**v1 needs no smart contracts.** Compute + Storage only.

---

## DOCUMENT STATUS

**This is a draft, not a validated plan.** Its central claims — that questions build trust rather than friction, that question count decays, that a TEE model can read Indian food, and that Indians will pay ₹199–299 — are all **NOT VERIFIED**. Sections 6 and 17 exist to test them, and Section 19's gates exist to stop the project if they fail.

What *is* established: the demand (§1.3), the accuracy problem (§1.1), the Indian food gap (§1.2), the failure patterns of everyone who tried before (`FEATURES.md`), and the 0G cost and privacy positions (§9.2, §14).

Reviewed against: `FEATURES.md`, `INDEX.md`, `FINDINGS-*.md`, `oglabs resources/`.
**Not reviewed by:** a clinician, an Indian lawyer, or a single real user. All three are required before launch.
