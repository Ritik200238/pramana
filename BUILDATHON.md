# BUILDATHON.md — what we are being judged on

The brief interpreted. Unlimited time, unlimited effort assumption — build the strongest possible project, not the fastest submission.

---

## Resourcing assumption

**Unlimited developers, unlimited time, unlimited effort.** No task is too hard or too large.
Nothing gets scoped down because it is difficult. Difficulty is not a reason to simplify —
only evidence is.

## What they want

Build a **real AI × Web3 application** on 0G's decentralized AI infrastructure.

- No fixed idea, no fixed track. We choose the problem.
- Must solve a **real problem** — not a blockchain demo.
- AI must be **meaningful**, not a chatbot bolted onto a Web3 app.
- 0G must be **meaningful** in the architecture.
- Should become a real, usable product that can run on **mainnet**.
- Cross-category projects are encouraged.

Interest areas: AI agents · AI safety/trust · AI + DeFi/finance · decentralized AI data & infrastructure · AI gaming/consumer apps · developer tools.

> **In short: build something genuinely useful where AI and blockchain work together, and make 0G an important part of how the product works.**

---

## Scoring weights

| Weight | Criterion | What it means |
|---|---|---|
| **40%** | Progress & Momentum | Meaningful advancement of the project this Wave, whatever stage you're at |
| **30%** | 0G Integration | Depth and quality of use of 0G's modular stack (Chain, Compute, Storage, Agentic ID, 0G Pay) |
| **20%** | Technical Quality & Execution | Code quality, architecture, security, completeness |
| **10%** | Traction & Communication | Real usage where applicable, documentation, demo clarity, public updates |

Also assessed: Project Vision & 0G Fit · Technical Approach & Architecture · Team & Execution Signal · Product-Market Fit · Innovation and Creativity · Smart contract quality.

**Implication:** shipping steadily and visibly (40%) outweighs any single clever feature. Deep 0G use (30%) outweighs polish (20%). A beautiful UI alone loses.

---

## 0G must not be decorative

30% of the score. DevRel verifies the integration is genuine.

**Do not build:** normal AI app → connect wallet → one throwaway transaction → claim "we use 0G".
**Do not fake it:** Frontend → OpenAI API → database → random 0G transaction ≠ "our AI runs on 0G".

Design so 0G **enables** something the product could not do otherwise.

| Component | Use it for |
|---|---|
| **0G Chain** | smart contracts, ownership, transactions, agent actions, on-chain state |
| **0G Compute** | AI inference, agents, model execution, training/fine-tuning, verifiable computation |
| **0G Storage** | AI datasets, model files, agent knowledge, large AI data |
| **0G DA** | high-throughput data availability |
| **Agentic ID / ERC-7857** | agent identity, ownership, transferability, persistent intelligence (we implement ERC-7857 semantics on ERC-721; see VERIFICATION.md) |
| **0G Pay** | agents paying each other, charging users, micropayments, buying compute |

---

## DO

**Product** — solve a real problem · make it actually usable · end-user first · complete user flow, not a backend prototype · something people would keep using · AI central where appropriate · blockchain solving a real problem, not decoration.

**0G** — integrate deeply · use the components that genuinely fit · explain *why* 0G is necessary · show exactly where it sits in the architecture · build toward mainnet · provide proof of integration.

**Engineering** — proper architecture · clean maintainable code · take security seriously · reproducible · setup instructions · deployable and testable by judges.

**Demo** — core functionality obvious · show the real user journey · show the 0G integration · polished frontend · understandable in a few minutes.

**Docs** — good README · architecture explained · which 0G components and how · how everything connects · reproduction/deployment instructions.

**Communication** — screenshots/video of the real product · what problem you solve · why AI is necessary · why blockchain is necessary · why 0G is necessary · evidence of real usage/testing.

---

## DON'T

- AI is just a chatbot on a blockchain app
- Blockchain has no real purpose
- 0G included to tick a box
- A copy of an existing project with minimal changes
- No real user problem
- Only a concept or mockup
- Judges cannot test it
- Messy or unreadable repository
- No setup instructions
- Architecture not explained
- 0G integration cannot be demonstrated
- Optimising only for "looking cool"

Rules also require work to be original or properly credited, prohibit IP infringement, and require the project to be deployable and testable by judges.

---

## Submission requirements

**Project** — name · one-line description · what it does · what problem it solves · which 0G components it uses.

**Code** — public/shared GitHub repo · meaningful commits · proper README · setup instructions.

**0G proof** — mainnet contract address · 0G Explorer evidence · clear proof of at least one 0G component integrated.

**Demo** — the actual product · the user flow · the 0G integration · publicly hosted demo video.

**Technical docs** — architecture diagram or technical explanation · 0G modules used · how they're used · deployment/reproduction instructions.

**Public X post** — project name · demo screenshot/clip · `#0GBridge` · `#BuildOn0G` · `@0G_labs` · `@0G_Builders` · `@AKINDO_io`

---

## Non-negotiables

1. The product must solve a real problem
2. AI must provide real value
3. Web3/blockchain must provide real value
4. 0G must provide real value
5. 0G integration must be genuine and demonstrable
6. The product must be actually usable, not a concept
7. Architected like a real production product
8. Security taken seriously
9. Code clean and understandable
10. Deployable and testable by judges
11. Proper documentation in the repo
12. Architecture explains the role of every major component
13. The entire user journey can be demonstrated
14. We can prove where and how 0G is used
15. All reused code properly credited / open-source where required
16. No third-party IP, copyright, patent, or trademark violation
17. The final product should be something we could realistically turn into a startup afterwards

---

## The mindset

Don't ask *"what can we build with 0G?"*

Ask: **"what painful problem becomes dramatically better because decentralized AI + blockchain + 0G exist?"**

Then work backwards:

```
Real problem
  → Amazing product
    → AI is genuinely useful
      → Blockchain is genuinely useful
        → 0G is genuinely useful
          → Deep technical architecture
            → Production-quality implementation
              → Beautiful UX
                → Proof + documentation + demo
```
