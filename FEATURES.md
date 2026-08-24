# FEATURES.md

**Working name:** TBD · **Platform:** PWA · **Market:** India-first · **Stack:** 0G Compute + 0G Storage

**Thesis:** Every AI food app guesses the amount and is 25–54% wrong. We ask two questions instead.
**Tagline:** *It asks. It doesn't guess.*

Ranked by proven demand, not by build difficulty. Every "PROVEN" line traces to research collected 24 Aug 2026 (`INDEX.md` + `FINDINGS-*.md`). Where a claim is single-sourced or contested, it says so.

---

## TIER 0 — THE CONSTITUTION

These are not features. They govern every feature below. **When a feature conflicts with a rule, the rule wins.**

### R1 — Never guess an amount. Ask.
The models always know *what* the food is. They cannot tell *how much* is on the plate. So we don't make them.
> *"The models always know what the food is. They just can't tell how much is on the plate. That's the whole problem."* — measured across 5 vision models, 2.5k upvotes

### R2 — Maximum two questions, and only if the answer moves the number >10%.
Ghee or no ghee = 100+ calories → ask. Onion or no onion → never ask.
> *"The moment I have to think, my adherence collapses."*

### R3 — Every number carries its confidence, visibly.
- 🟢 **EXACT** — barcode or packet label
- 🟡 **CONFIRMED** — you told us the amount
- 🔴 **ROUGH** — we estimated it

A barcode must not look like a guess. A guess must not look like a barcode.

### R4 — Never ask the same question twice.
Day 1 asks three questions. Day 30 asks none. **Friction falls as the record grows. This is the whole moat.**

### R5 — A correction is permanent.
Fix it once, fixed forever, for you. Your dal becomes *the* entry for your dal.

### R6 — The user talks, we listen and remember. Always.
Anything they say — food, mood, sleep, stress, a symptom, a bad week — enters the record and stays there. Nothing said to us is ever thrown away.

---

## TIER 1 — THE PRODUCT

Highest PMF. Without all nine, there is no app. Ship nothing else until these are excellent.

---

### 01 · Photo → identify → **ask** the amount → log
AI names every item on the plate; you confirm quantity in household units — katori, roti, glass, plate — never grams.

- **PROVEN:** Cal AI — 15M+ downloads, $30–50M revenue in <2 years, acquired by MyFitnessPal. The mechanic is settled.
- **FIXES:** the measured failure mode — models identify correctly, estimate quantity terribly (Gemini 21% → Grok 54% error).
- **0G:** ✅ `qwen3-vl-30b`, TEE-attested, ~₹1.26/user/month.

---

### 02 · The life chat — tell it anything, any time ⭐ NEW
One always-open conversation. Not a food logger — a place to say whatever is true right now:

> *"slept badly, maybe 5 hours"*
> *"gym today, legs, felt weak"*
> *"stressed, exams next week"*
> *"skipped lunch, had chai and biscuits at 4"*
> *"stomach's been off for 3 days"*
> *"travelling to Delhi Thursday, hostel food till Sunday"*
> *"periods started"*

Everything typed or spoken here becomes **structured, timestamped, permanent context**. Food entries auto-log. Symptoms, mood, sleep, workouts, travel, cycle, medication — all captured without a single form.

- **PROVEN — this is exactly what 230M people/week already do with ChatGPT.** And the reason they do it is not intelligence, it's **time**:
  > *"With GPT you have no pressure and lots of time to discuss at anytime you notice or remember things you missed."*
  > *"I love my PCP, but I see her for 30 minutes every 3 months."*
- **PROVEN — the payoff case, 569 upvotes:** a user logged food *and* symptoms for weeks. The AI spotted the correlation (no symptoms on days he ate early and had more salt). His cardiologist confirmed it. *"I've complained about all of these symptoms to doctors for DECADES."*
- **FIXES:** the #1 complaint about every shipped coach — *"Whoop AI coach can't read its own sets, reps and weight data… it said I needed to type all this information manually into the prompt."* We have everything because the user told us, in one place.
- **WHY IT'S TIER 1:** this is the substrate. R4 and R5 have nothing to compound without it. Feature 12 (ask-your-data) is impossible without it. **It is the product's memory.**
- **0G:** ✅ `qwen3.7-plus` (TEE) for extraction + `whisper-large-v3` for voice. Structured output → Postgres. Encrypted snapshot → 0G Storage.

**Design constraints:**
- Never demands input. Silence is fine.
- Extracts silently — no "I've logged 3 items" spam.
- Shows what it understood, tappable to correct (→ R5).
- One thread, not per-topic channels. Life is not foldered.

---

### 03 · The AI asks *you* — proactively ⭐ NEW
The other half of 02. The coach initiates, on its own, when it has a reason:

**Gap-filling** — *"You logged dinner but not lunch. Mess food?"*
**Pattern-checking** — *"Third low-energy day this week. Sleeping less, or something else going on?"*
**Follow-up** — *"Stomach still off? You mentioned it Tuesday."*
**Calibration** — *"You've logged rajma 6 times. Same recipe each time — should I save it as yours?"*
**Context-seeking** — *"Exams next week — want me to keep meals simple till then?"*

- **PROVEN:** users explicitly and repeatedly ask for this —
  > *"Really like the idea, especially the part asking AI to ask you question — Brilliant."*
  > *"Given what you know about me… what are 3 things I might not have considered?"* (131 likes)
- **PROVEN:** HiMe (arXiv + App Store) ships *"proactive insights 24/7"* with scheduled checks and event triggers. Google's PHA orchestrator does *"iterative collaboration, reflection, and memory updates."*
- **FIXES:** *"I'm at the state of 'I don't know what I don't know'. And want my data to tell me what I need to know."*
- **0G:** ✅ Scheduled + event-triggered. Model call only when a trigger fires.

**Hard limits (this feature is the easiest to ruin):**
- **Max one proactive message per day.** Ever.
- Only when there is a *specific, personal* reason. Never "Don't forget to log!"
- Never at night.
- One tap to say "ask me less" — and it obeys permanently.
- **Never re-raises a resolved thing.** The gaslighting failure, verbatim:
  > *"3 months later. It keeps telling me I need to modify my activities for my foot pain. I told it to stop… it said it would erase that info, and it's there again… it began to gaslight me."*

---

### 04 · Confidence label on every entry
🟢 / 🟡 / 🔴 on each item and each daily total. Tap to see exactly which assumption is soft.

- **PROVEN:** requested by name — *"a home cooked composite dish gets an approximate label with assumptions clearly visible."*
- **FIXES:** *"Users forgive manual loggers for being off. They do not forgive AI. If the AI says a pizza is 200 calories, trust evaporates instantly."*
- **0G:** Not an AI feature. Plain code around model output.

---

### 05 · "Your usual?" — one-tap repeat
After a few repeats, questions collapse to one confirmation.

- **PROVEN:** *"I will happily pay full price every month. I just desperately want this product to exist."* (~$19.99/mo named)
- **FIXES:** the activation cliff — <3 sessions in first 14 days = 3–4× churn.
- **0G:** Database, not model.

---

### 06 · Protein as the hero number, calories second
Home screen shows protein remaining today. Calories underneath.

- **PROVEN:** Indian macro-explainer videos: 836K / 436K / 317K views. Demand for the number exists; nobody serves it well.
- **FIXES:** gives the app one job a user can name in a sentence.
- **0G:** Deterministic arithmetic. Never a model call.

---

### 07 · Hinglish, typed or spoken
*"2 roti aur rajma"* logs correctly. Photo is the fast path, not the only path.

- **PROVEN:** 1★ Healthify review asks for exactly this: *"no option there to describe what I ate in textual form that gets auto filled in the database using AI."* HealthifyMe's Ria Voice ships 14+ Indian languages.
- **FIXES:** photos fail at restaurants, in the dark, and for anything already eaten.
- **0G:** ✅ `whisper-large-v3`.

---

### 08 · Your own food library
Correct "dal tadka" once → saved with your ghee, your portion, your recipe.

- **PROVEN:** *"'dal tadka' gave 6 different entries with wildly different calories. 'poha' — half the entries don't even have protein data."* And on crowd databases: *"values seem to be random guesses, with a bias towards lowball, guilt-assuaging numbers."*
- **FIXES:** the most specific Indian complaint found — 10+ listings per food, Hindi/English colliding, no synonym mapping.
- **0G:** Database. Also the compounding moat.

---

### 09 · A free tier that is genuinely usable forever
Unlimited logging + life chat + targets + your food library = free, permanently. Paid unlocks coach depth, weekly review, report reading.

- **PROVEN:** *"I'm not asking for a personal trainer or fancy AI stuff. Just a decent free app."* In India, free tracking is praised in the same reviews that condemn paid coaching.
- **FIXES:** paywall creep is the #1 stated quit reason across every incumbent's 1★ reviews.
- **0G:** ⭐ **This is what 0G actually buys you.** ₹1.26/user/month vs ₹87 on Claude Sonnet. The free tier is only affordable at 0G pricing.

---

## TIER 2 — WHAT MAKES THEM COME BACK

Proven demand. Retention lives here. Build after Tier 1 is excellent.

---

### 10 · "What should I eat right now?"
Answered from your kitchen, your mess menu, or the restaurant in front of you.
- **PROVEN:** Acara Plate shipped this exact agent. 134 likes: *"tell Chat the things in my frig or cabinet I need to use."*
- **0G:** ✅ `qwen3.7-plus`

### 11 · One line at the end of the day
What went well + the single thing to change tomorrow. No graphs, no scores.
- **PROVEN:** said verbatim in three subreddits — *"once the data is there, it mostly stops at charts"* · *"tons of metrics, zero actual coaching."*
- **0G:** ✅

### 12 · Ask your own data anything
*"Why was I tired this week?"* *"What changed when I travelled?"* Answered from your log, evidence shown.
- **PROVEN:** Google's research names "interpreting personal data" as one of four core needs from 1,300+ real queries.
- **FIXES:** *"it keeps telling me it only sees the last 7 days of data, which is….useless?"*
- **0G:** ✅ Requires **full history** in context — the opposite of what Whoop and Oura do.
- **DEPENDS ON:** 02.

### 13 · Nudges at *your* meal times
Learned from when you actually log, not a default 8/1/8.
- **PROVEN:** notification opt-out predicts 3–4× churn in 30 days. The way to keep them on is to make them correct.
- **0G:** Scheduler. No model.

### 14 · Weekly review — what changed + one adjustment
Patterns stated as observations, never as diagnosis.
- **PROVEN:** *"they collect all this data but then you have to manually connect dots that should be automatic."*
- **0G:** ✅ The one place worth a stronger model.

### 15 · Streaks with a forgiveness day
Logging streak + protein-target streak. One free miss per week, automatic.
- **PROVEN:** Duolingo's streak freeze. Guilt loses users; forgiveness keeps them.
- **0G:** No model.

### 16 · Upload a blood report → plain language
Photograph the lab PDF. Every marker in one sentence, Hindi or English, with what's normal and what to ask a doctor.
- **PROVEN:** ⭐ **the largest gap in the entire research.** Hindi videos explaining reports manually: ECG **2.2M**, cancer **1.05M**, ultrasound **903K** views. Best AI-native version: **706 views.**
- **FIXES:** 19% of AI health users are already asking chatbots to explain test results — badly.
- **0G:** ✅ Where TEE matters most. ⚠️ **Verify Indian report OCR before committing.**

### 17 · Markers tracked over time
HbA1c, cholesterol, vitamin D, haemoglobin auto-extracted into one line per marker.
- **PROVEN:** Function Health — $100M+ ARR in <2 years, $2.5B valuation, essentially on this.
- **0G:** ✅ Encrypted longitudinal record on 0G Storage.

---

## TIER 3 — WHY YOU AND NOT THEM

Each closes a wound the research found open. Cheap to build, disproportionate to trust.

### 18 · Export everything, always, free
One button. CSV + PDF. Works whether or not you're paying, forever.
- **PROVEN:** 387 likes — *"Once you stop your subscription you lose your data. Wow that's an automatic no from me."* · *"Healthifyme does not export the key nutrition data — trying to lock users in only gets them to go elsewhere."*
- **0G:** 0G Storage makes it the default, not a feature.

### 19 · No auto-renew. Cancel in one tap. Say so on the pricing page.
No ₹3 trial. No card before value. Visible cancel button inside the app.
- **PROVEN:** Indian review sections are dominated by this — *"3 rs trial ke liye pay kiya… 3 days ke baad 499 mere cut gye"* · *"1 mahine mein 6 baar money deduct kar li. Total 1794."*
- **FIXES:** you inherit this suspicion whether you earned it or not. **Cheapest differentiator available in India.**

### 20 · Zero sales calls. Ever. In writing.
No phone number required. No consultant will ring you.
- **PROVEN:** *"I used to get 15 to 20 calls each day after installing this app."* · *"Rude dietitian… The call traumatised me."*
- **0G:** Policy, not tech. Costs nothing. Worth more than a feature.

### 21 · Household profiles
One cook, several eaters. Mum's diabetes, your cut, your sister's PCOS — one kitchen, one grocery list, three targets.
- **PROVEN:** asked directly in an Indian review — *"How add other persons like my husband's and daughter's profile?"* Acara treats `UpdateHouseholdContext` as a first-class tool.
- **0G:** Data-model decision. **Make it now** — retrofitting is painful.

### 22 · A bluntness dial
Gentle · Straight · Blunt. Default Straight. Never flatters at any setting.
- **PROVEN:** 253 likes — *"prompt him to be more contentious using logic and science."* · *"the coach shouldn't be so sycophantic."* · *"LLMs are yes men."*
- **0G:** System prompt. Free.

### 23 · Doctor visit pack
One page of trends + the three questions worth asking. Printable, shareable.
- **PROVEN:** 108 likes — *"Your GP's eyes glazing over while you're talking about your health markers is the reason companies like Function Health are blowing up."* "Visit prep" is one of eight workflows in the most-starred family health vault on GitHub.
- **FIXES:** people want AI to *prepare* them for the doctor, not replace one. Doctor-authority content out-views every AI tutorial ~5×.

### 24 · Hard red-flag routing
Chest pain, fainting, blood, sudden weight loss → deterministic keyword match **before any model sees the message** → "see a doctor now."
- **PROVEN:** PatientAgentBench — **triage is the weakest dimension for every model tested** (32–47% pass for open models). So we don't let a model do triage.
- **FIXES:** the specific Indian fear — *"it could tell you a heart attack is just gas pain."*
- **0G:** ❌ Plain code. Never a model call. **Non-negotiable.**

### 25 · ED guardrails and calorie floors
Hard minimums regardless of what the user asks for. Deterministic screening on every message. Under-18 and underweight-cut requests refused outright.
- **PROVEN:** Yara's founder shut down an AI therapy app voluntarily for being too dangerous. Illinois and Nevada fine unlicensed AI mental-health care $10,000–$15,000 per violation.
- **0G:** ❌ Plain code, not prompt text. **This layer must not be persuadable.**

### 26 · Ghee and oil as a first-class field
Every Indian dish carries a cooking-fat property with a household default set once. Roti-with-ghee and roti-without are different foods.
- **PROVEN:** the objection nobody could answer — *"how do you intend to track roti with ghee or roti without ghee?"* · *"a dry pan vs a slick of olive oil can be 100+ cal difference and the photo looks identical."*
- **0G:** Schema decision. R2 made concrete.

---

## TIER 4 — THE MOAT, LATER

Only after D30 retention is real. These compound; they don't acquire.

### 27 · Self-calibrating targets from weight trend + intake
After a few weeks the app stops trusting the formula and fits your actual metabolism from logged intake vs weight change.
- **PROVEN:** technical users name this themselves — *"the only way short of checking into a metabolic ward to know your own body's true energy usage."*
- **FIXES:** ⭐ **the deepest fix on this list.** Makes consistent logging errors *self-correcting*. If you always under-report by 15%, the fitted target absorbs it. **Photo accuracy stops being existential.**
- **0G:** Statistics, not AI.

### 28 · Encrypted, user-owned record on 0G Storage
Meals, chat, weight, reports, markers — encrypted client-side, portable, outliving the app.
- **PROVEN:** 77% of adults concerned about medical data privacy. Self-builders hand-roll local Ollama stacks specifically to avoid uploading health data.
- **0G:** ⭐ **The one feature that genuinely needs 0G.** Nightly batched snapshot, never per-meal writes. Keep the root hashes or lose the data.

### 29 · Retest reminder + before/after
12 weeks after a report, remind them to retest, then show both side by side.
- **PROVEN:** JAMA Phase 3 RCT (Oct 2025, n=368) — AI coaching non-inferior to accredited human coaches on a 12-month clinical endpoint. A moved marker is the only proof consumers can't argue with.

### 30 · Human escalation, paid, on demand
A real dietitian, per consultation, only when asked. Never assigned, never rotated, never calling you.
- **PROVEN:** HealthifyMe's split — 77% find AI sufficient, 23% escalate. Their failure is the warning: *"they change the coach every month… without any output."*

### 31 · Shareable weekly card
One image: protein hit, streak, one honest line. Built for WhatsApp status, not a feed.
- **PROVEN:** necessary because the obvious channel is closed — r/diabetes permanently bans app posts and "AI stories"; r/loseit calls AI-app recruiters predatory.

### 32 · Your corrections become your model
Every confirmed portion, fixed dish, rejected suggestion tunes what the app assumes about you.
- **PROVEN:** Acara has this open as an issue and *sells* long-running semantic memory as its premium tier.
- **FIXES:** R4 + R5 compounding. The reason a competitor starting today can't catch a user who's been with you six months.
- **0G:** ✅ `0g-memory` exists in the resources folder if you want it decentralised.

---

## DELIBERATELY NOT BUILDING

Each was tried by someone with more money, and failed for a documented reason.

| Refused | Why |
|---|---|
| **A single wellness score** | The exact mechanism of wearable churn: *"A composite number with no published weighting cannot be wrong: if it says 82 and you feel destroyed, there is no observation that contradicts it, so after a few weeks you stop looking."* |
| **A generic "AI health coach"** | Acara built `HealthCoachAdvisor` + `PersonalTrainerAdvisor` then **deleted both**. Apple **shelved** Project Mulberry (Feb 2026). Google and OpenAI now occupy this slot for free. |
| **Anything requiring a wearable** | Whoop, Oura, Google, Apple own that data and are building coaches on it. Most Indians own no wearable. |
| **A symptom checker** | Triage is the least-solved capability in the field. Ada and K Health have raised nothing meaningful since 2024. |
| **Silent guessing to look magical** | Cal AI is 25–54% wrong and reviewers revolt: *"Being 200kcal off is the gap between a healthy calorie deficit and staying the same weight."* Looking magical is what makes the fall hurt. |
| **Reddit / community marketing** | r/diabetes: *"No ads, fundraising, surveys, apps or AI stories."* The channel is closed. Plan around it. |
| **Any claim to diagnose or treat** | The Whoop precedent: measuring a diagnosable parameter makes it a medical device regardless of "wellness" framing — and the warning letter anchored a class action even after the FDA stood down. |

---

## WHAT 0G ACTUALLY BUYS YOU

Verified live against `router-api.0g.ai/v1/models`, not assumed.

- **The free tier.** `qwen3-vl-30b` ≈ **₹1.26/active user/month** vs ₹87 for Claude Sonnet on identical usage. Feature 09 — the loudest Indian demand — is only affordable because of this.
- **A provable privacy claim.** TEE-attested inference (Intel TDX / dstack): "we cannot read your report" becomes cryptographic, not a policy sentence. Applies to `qwen3-vl-30b`, `qwen3.7-plus`, `0gm-1.0-35b-a3b`, `kimi-k3`, `minimax-m3`.
- **A record the user owns.** 0G Storage + ECIES → feature 28. Portable, survives the company.
- **Vernacular voice.** `whisper-large-v3` is served → feature 07 needs no separate vendor.

**Cautions:**
- ⚠️ `claude-*` and `gpt-*` on the Router report **no TEE attestation** — proxied. Billing convenience, not a privacy guarantee. **Never route identified health data through them** if you make the privacy claim.
- ⚠️ Most models list only **1–2 providers**. Ship a fallback chain before any real launch.
- ⚠️ **UNVERIFIED:** whether any of these models can read an *Indian* meal or an *Indian* lab report accurately. Everything rests on this. **Test before building.**

---

## BUILD ORDER

1. **Tier 1** (01–09) — no app without all nine
2. **Tier 3 safety** (24, 25) — before a single external user
3. **Tier 2** (10–17) — retention
4. **Tier 3 trust** (18–23, 26) — cheap, high leverage
5. **Tier 4** (27–32) — only after D30 retention is real

---

## NEXT: UX

Open questions to work through before any UI:
- PWA shell — install prompt, offline, home-screen behaviour
- Onboarding — how few taps to first real value
- Where the life chat (02) lives relative to the camera and the day view
- How proactive messages (03) arrive without feeling like notifications spam
- The daily loop: open → log → see → feel → close
- The weekly loop: review → adjust
- The outcome moment: what "it's working" looks like on screen
