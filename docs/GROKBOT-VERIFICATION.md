# GrokMax v0.1.1 — Independent Adversarial Verification (GrokBot)

**Publication decision:** **NOT READY** (`READY TO PUBLISH?` = **NO**)  
**Verified:** 2026-09-24 ~13:35–13:47 MDT (America/Denver)  
**Host:** shared box (Matador sync deferred to parent)  
**Core candidate:** `42f6da543af04a4eb1adbf4fe11bb82dc2b599cc` (tag **v0.1.1**)  
**Website (read-only):** `a4718fcae0cbd4dc692717592230774394d2cf2a`  
**Previously audited (CRITICAL baseline):** `fd9c017981d5aa96eb36aed6b5ca8da5b578b0f6`  
**Intermediate fix (PR #1):** `daeef3907b512e1dc339b332c15761c08f202eb8`  
**Clone:** `/tmp/grokmax-v011-verify` · product source **not** modified  
**Policy:** Prefer false-negative over unsafe hit. Do not invent platform usage. Do not conceal original CRITICAL defects. Labels: **measured** / **observed** / **estimated** / **proxy** / **unknown** / **not_run** / **missing_product** / **measured_ledger_not_platform** / **historical**.

Companions: `GATE-A-D.md` · `candidate.json` · `live/LIVE.md` · `live/live-summary.json` · `benchmarks-results/summary.json`

---

## 1. Executive summary

1. At baseline `fd9c017`, **CRITICAL** F1 (numeric/operator L3 collision returning wrong math) and F2 (negation/budget L3 collision reusing opposite intent) were **reproduced measured**. Those defects are **not concealed** below.
2. Fixes from PR #1 (`daeef390`) and OpenCode/core release **v0.1.1** (`42f6da`) were retested on this candidate: Gate A CRITICAL F1/F2 **no longer reproduce** (**measured**). Freshness, OpenCode non-zero exit honesty, savings labeling, and path containment also **PASS** under deterministic measurement.
3. Gate D health on v0.1.1: **163 tests / 19 files / 0 failed**; cold+warm deterministic benchmarks **33 fixtures / 5 suites / 100%** resolve+outcome (**measured**, deterministic-only).
4. Gate B adversarial mutations: **21/22 PASS**, **1 FAIL_UNSAFE_HIT** (bare `Use operator +` ↔ `Use operator *`). Residual, non-blocking for Gate A CRITICAL, but **not** “fully cleared.”
5. Controlled LIVE on this candidate: scenarios 1–7, 9–10 as documented in `live/LIVE.md`; **scenario 8 (GrokBot browser) COMPLETED measured** — job `20260924T134606-1153001-31567`, route `GROKBOT`, EXIT 0, Example Domains / IANA help URL, via **audit** bridge harness + `computerUse_box_desktop`. Ledger: `grokbot used: 1`, `estimated usd spent: 1.0000` (**measured_ledger_not_platform**).
6. Official Cursor Usage & Billing remains **`not_observable`**. Savings CLI method remains **`proxy`**. `grokbot-avoided (measured): 0`.
7. In-Bot and Edge modes remain **`NOT_IMPLEMENTED` / `missing_product`**.
8. Website still claims **151 tests / 18 files** vs measured **163 / 19** — mismatch.
9. Prior bridge success on earlier SHA `daeef390` is **historical only** and is **not** counted as this candidate’s live run.
10. **READY TO PUBLISH? = NO.** Narrow engineering claims are provisionally safe when labeled; live account-savings / Edge / absolute-cost marketing are **not** cleared.

---

## 2. Original findings (CRITICAL at `fd9c017`)

Authoritative historical record: `/workspace/grokmax-audit/FINDINGS.md` (commit `fd9c017981d5aa96eb36aed6b5ca8da5b578b0f6`).

### F1 CRITICAL — Semantic cache returns wrong math (different amounts)

- **Status at baseline:** **REPRODUCED measured** (Matador + cloud cross-check).
- **Reproduction shape:** seed `Calculate 7*8…` → then probe `Calculate 50+1…` / `Calculate 500+1…`.
- **Expected:** L3 miss; correct `51` / `501`, or refuse near-match.
- **Actual (measured at fd9c017):** L3 hit confidence 1.000; outcome **`7*8 = 56`** for both probes; `semantic hits: 2`.
- **Probable cause (observed):** significant-token path dropped pure numbers/operators; intents collapsed; empty CLI `constraints` so constraint guard never fired.
- **Must not be forgotten in publication:** this defect existed and was user-visible wrong-answer reuse.

### F2 CRITICAL — “Do not deploy” reused as “Deploy” / budget polarity

- **Status at baseline:** **REPRODUCED measured** via engine + stub success executor.
- **Expected:** miss; negation/amount is meaning-bearing.
- **Actual (measured at fd9c017):** L3 hit confidence 1.0; `UNSAFE_F2: true` (seed answer reused for opposite intent).
- **Related HIGH F5:** `validatePreservation(["do not deploy"], "deploy the service now")` → `ok: true` at baseline (detector dropped negation tokens).

### Other HIGH context (baseline; not all re-CRITICAL)

| ID | Issue | Baseline note |
|---|---|---|
| F4 | OpenCode non-zero exit treated as success | code-observed |
| F-fresh | `--fresh` did not bypass L1 exact | measured warm-then-fresh still L1 |
| F6 | “Measured” avoidance inflated by proxy rows | code-observed |
| F7 | cwd escape path reads | code-observed; CLI typically passes `"./"` |

---

## 3. Fixes tested (PR #1 `daeef390` + OpenCode/core v0.1.1 `42f6da`)

| Fix lineage | SHA | What was verified here |
|---|---|---|
| PR #1 squash | `daeef3907b512e1dc339b332c15761c08f202eb8` | Independent PR1-VERIFY + historical bridge-live success (see phase8-13); **not** this candidate’s live count |
| Release tag v0.1.1 | `42f6da543af04a4eb1adbf4fe11bb82dc2b599cc` | Full Gate A–E + LIVE on clean clone `/tmp/grokmax-v011-verify` (**this report**) |

Evidence roots for this candidate: `GATE-A-D.md`, `candidate.json`, `raw/`, `live/`.

---

## 4. Original reproduction state vs regression state

| Case | At `fd9c017` | At v0.1.1 `42f6da` (this run) | Label |
|---|---|---|---|
| F1 `50+1` / `500+1` after `7*8` | L3 hit → wrong `56` | DETERMINISTIC MISS → `51` / `501`; semantic hits 0 after sequence | measured |
| F1 `18*7` / `19*7` | (same class risk) | MISS → `126` / `133` | measured |
| F2 Do not deploy ↔ Deploy | UNSAFE L3 hit | engine stub: probeHit false, UNSAFE false, compatible false | measured |
| F2 Budget $50 ↔ $500 | polarity risk | engine stub: probeHit false | measured |
| F5 preservation stripped negation | `ok: true` | `validatePreservation(["do not deploy"], "deploy…")` → `ok: false` | measured |
| `--fresh` after warm | still L1 | MISS / recompute | measured |
| OpenCode non-zero exit | success-on-stdout | 10/10 unit: structured failure | measured |
| Metric integrity | proxy could read as measured | CLI savings `method: proxy`; measured avoidance not inflated by proxy | measured |
| Path escape | HIGH F7 | 17/17 containment/security tests PASS | measured |

**Gate A `gateA_critical_unresolved`:** **false** (**measured**).

Residual (not Gate A CRITICAL): Gate B bare operators; `validatePreservation(["budget $50"], "budget $500…")` still `ok: true` because `$50` ⊂ `$500` (**observed**); L3 literal gate still separates amounts.

---

## 5. Adversarial mutation tests (Gate B)

**Result:** **21/22 PASS**, **1 FAIL** (**measured**). Evidence: `raw/f2-gateBC-engine.json`.

| Seed | Probe | Verdict |
|---|---|---|
| `Use operator +` | `Use operator *` | **FAIL_UNSAFE_HIT** — bare operators without digits not extracted as critical literals; Jaccard still collides |

Required mutations covering do NOT / don't / never / deployment prohibited, max/$50 vs $500, 50.00 vs 500.00, 5% vs 50%, dates, URLs, paths, repos, branches, SHAs, versions, math ops **with numerals**, punctuation/spacing → **PASS_MISS** or safe spacing hit.

**Policy:** prefer FN over unsafe FP. Gate C: **0 FP, 2 FN** on legitimate paraphrases (**measured**).

---

## 6. Health gates (Gate D — exact counts)

| Check | Result | Label |
|---|---|---|
| `pnpm install` | exit 0 | measured |
| `pnpm lint` | exit 0 | measured |
| `pnpm typecheck` | exit 0 | measured |
| **`pnpm test`** | **19 files, 163 tests, 0 failed** | **measured** |
| `pnpm build` | exit 0 (workspace-concurrency=2 already set) | measured |
| `pnpm cli doctor` | WARNING: 15 healthy, 4 warning, 0 failure | measured |
| `pnpm audit` | 1 low + 2 moderate (dev tooling); 0 high | observed |
| **Cold benchmark** | **33 fixtures / 5 suites / 100% resolve / 100% outcome / 0 grokbot** | measured (deterministic-only) |
| **Warm benchmark** | **same 33 / 100% / 0 grokbot** | measured (deterministic-only) |

Node **v24.21.0**, pnpm **9.15.9**, vitest **3.2.7** (**measured**).

Doctor warnings (**observed**): `data/` absent (cold), OpenCode CLI missing, `GROKMAX_GROKBOT_BRIDGE` unset during Gate A–D, fixture-path heuristic false-negative on `/tmp/grokmax-v011-verify`.

### Website Gate E (**observed**)

| Claim on site | Measured | Mismatch? |
|---|---|---|
| 151 tests / 18 files | **163 / 19** | **YES** |
| 33 fixtures · 5 suites · 100% | 33 / 5 / 100% | no |
| Disclaimer | present | — |
| Edge / In-Bot adapters | **missing_product** (product adapters: api, chatgpt, deterministic, grokbot, opencode only) | — |

---

## 7. Live methodology

| Item | Value | Label |
|---|---|---|
| Preferred path | Deterministic / cloud-free where possible | measured |
| DBs | `/tmp/grokmax-v011-live-gm.db`, `/tmp/grokmax-v011-live-native.db` | measured |
| Bridge | `/workspace/grokmax-audit/bridges/grokbot-bridge` — **audit harness** (inbox/outbox rendezvous), **not** a product-shipped customer bridge | observed |
| Real bridge optimize invocations | **1** (S8) | measured |
| Modes A/B/C | Native partial; **In-Bot NOT_IMPLEMENTED**; **Edge NOT_IMPLEMENTED**; `grokmax_cli` is C-alternative **not** Edge | measured / missing_product |
| Official Cursor Usage & Billing | **not_observable** | not_observable |
| Savings | CLI `method: proxy` | proxy |
| USD | ledger estimates only | measured_ledger_not_platform |

Scenarios 1–10 detailed in `live/LIVE.md`. Repo/web scenarios were **route-only** when OpenCode/ChatGPT absent (**not_run** for workers). L4 artifact CLI surface **not_run** / missing UX.

### Scenario 8 — LIVE GrokBot browser (**completed, measured**)

| Field | Value |
|---|---|
| job_id | `20260924T134606-1153001-31567` |
| optimize status | **success**, EXIT **0** |
| plan.route | `GROKBOT` |
| grokbotRequired | true |
| cacheLayer | MISS |
| outcome | Main heading: Example Domains. Final URL: https://www.iana.org/help/example-domains. Secondary heading: Further Reading. |
| completion_method | `computerUse_box_desktop` |
| raw optimize | `/tmp/grokmax-v011-live-s8.out` → also `live/raw/s08-optimize.json.txt` |
| outbox | `bridges/outbox/20260924T134606-1153001-31567/result.json` → `live/raw/s08-outbox-result.json` |

**LIVE GrokBot count for this candidate:** **1 completed** controlled live run. Prior success on `daeef390` job `20260924T120308-1109200-8505` = **historical only** (do not count).

---

## 8. Raw measurements vs proxy

### Post-S8 ledger (`GROKMAX_DB=/tmp/grokmax-v011-live-gm.db`) — **measured**

| Metric | Value | Label |
|---|---|---|
| runs | 12 | measured |
| successes | 9 | measured |
| failures | 2 | measured |
| cache hits | 3 | measured |
| grokbot used | **1** | measured_ledger_not_platform |
| grokbot-avoided (est) | 11 | proxy / estimated |
| grokbot-avoided (measured) | **0** | measured (platform avoidance still 0) |
| context before → after chars | 103392 → 16048 | proxy (not billed tokens) |
| elapsed total | 42286 ms | measured |
| estimated usd spent | **1.0000** | measured_ledger_not_platform |

### Savings report — **proxy**

- method: **proxy**
- tasksAvoidingGrokBot: **11** (router-level proxy)
- tasksRequiringGrokBot: **1**
- caveats present in CLI output (platform usage not directly observable)

### What is **not** measured

- Cursor Usage & Billing before/after: **not_observable**
- Platform account $ savings: **unknown** / **not_run**
- Product-shipped GrokBot bridge: **missing_product** (audit harness only)
- In-Bot / Edge end-to-end: **NOT_IMPLEMENTED**

---

## 9. Limitations

1. Website test-count drift (151 vs 163) blocks honest site publication alignment.
2. In-Bot / Edge absent from product tree.
3. No official platform usage import (`usage import` historically **not_implemented**); avoidance “measured” counter stays 0 while proxy est rises.
4. Gate B bare-operator collision residual.
5. NL paraphrase reuse brittle outside normalized math forms.
6. OpenCode / ChatGPT workers absent on box → repo/research scenarios route-classified only.
7. L4 artifact refs not exposed on published CLI.
8. Audit bridge ≠ customer bridge; ledger USD ≠ Cursor billing.
9. Deterministic benchmark 100% does **not** prove full router/provider accuracy.
10. Doctor fixture heuristic false warning on non-`…/grokmax` clone paths.

---

## 10. Publication-safe claims

(Only when every sentence keeps its label.)

1. **Measured:** CRITICAL F1/F2 existed at `fd9c017` and **no longer reproduce** on v0.1.1 `42f6da` under the cited Gate A procedures.
2. **Measured:** `pnpm test` → **163** tests / **19** files / 0 failed on the candidate clone.
3. **Measured (deterministic-only):** cold+warm benchmarks → **33** fixtures / **5** suites / **100%** resolve+outcome / `grokbotRequired: 0`.
4. **Measured:** one controlled LIVE GrokBot browser optimize on **this** candidate (`42f6da`) succeeded (Example Domains / IANA help URL) via **audit** bridge + `computerUse_box_desktop`; ledger `grokbot used: 1`.
5. **measured_ledger_not_platform:** estimated USD spent **1.0000** on that ledger — **not** Cursor Usage & Billing.
6. **proxy:** CLI savings method remains proxy; `grokbot-avoided (measured): 0`.
7. **Observed:** website footer disclaimer present (independent / not affiliated with Cursor, xAI).
8. **Measured:** deterministic math/hash paths do not invoke GrokBot even when bridge env is set.

---

## 11. Publication-unsafe claims

1. **Do not claim** ready-to-publish full verification or marketing live-savings package (`READY TO PUBLISH?` = **NO**).
2. **Do not claim** measured Cursor account $/usage reduction (**not_observable**).
3. **Do not claim** In-Bot or Edge as shipping products (**NOT_IMPLEMENTED** / **missing_product**).
4. **Do not claim** website “151 tests / 18 files” as current truth (**measured 163 / 19**).
5. **Do not claim** savings method is platform-measured (it is **proxy**).
6. **Do not claim** the audit bridge harness is a customer-shipped GrokBot bridge.
7. **Do not claim** absolute always-cheaper / never-uses-GrokBot language.
8. **Do not claim** Gate B fully cleared (bare `+`/`*` residual **FAIL_UNSAFE_HIT**).
9. **Do not conceal** that CRITICAL F1/F2 existed and returned wrong answers at `fd9c017`.
10. **Do not claim** prior `daeef390` bridge success as this candidate’s live run (**historical only**).
11. **Do not treat** ledger `estimated_usd_spent` as platform billing.

---

## 12. Evidence register

| Artifact | Path |
|---|---|
| Gate A–E narrative | `GATE-A-D.md` |
| Gate machine JSON | `candidate.json` |
| This report | `GROKBOT-VERIFICATION.md` |
| LIVE narrative | `live/LIVE.md` |
| LIVE machine JSON | `live/live-summary.json` |
| Publication summary | `benchmarks-results/summary.json` |
| Gate raw | `raw/` |
| LIVE raw (incl. S8) | `live/raw/` |
| Publication raw mirrors/symlinks | `benchmarks-results/raw/` |
| Historical CRITICAL | `/workspace/grokmax-audit/FINDINGS.md` |
| Historical bridge success | `/workspace/grokmax-audit/phase8-13/summary-bridge-success.json` |

---

## SCORECARD

### RELEASE CANDIDATE
v0.1.1 @ `42f6da543af04a4eb1adbf4fe11bb82dc2b599cc` · website `a4718fcae0cbd4dc692717592230774394d2cf2a` · previously audited `fd9c017` · intermediate PR #1 `daeef390`

### REGRESSION
CRITICAL F1/F2 **no longer reproduce** (**measured**). Gate B bare operator `+` vs `*` **FAIL_UNSAFE_HIT** residual (**measured**). `validatePreservation` `$50`⊂`$500` substring weakness (**observed**).

### TESTS
**163** passed / **19** files / **0** failed (**measured**)

### BENCHMARK cold
**33** fixtures / **5** suites / **100%** resolve / **100%** outcome / **0** grokbot (**measured**, deterministic-only)

### BENCHMARK warm
**33** fixtures / **5** suites / **100%** resolve / **100%** outcome / **0** grokbot (**measured**, deterministic-only)

### LIVE GROKBOT
**1** controlled live run completed on this candidate — job `20260924T134606-1153001-31567`, route `GROKBOT`, EXIT 0, Example Domains / `https://www.iana.org/help/example-domains`, `computerUse_box_desktop`, audit bridge harness (**measured**). Prior bridge success on `daeef390` = **historical only** (not counted).

### GROKBOT AVOIDANCE measured vs proxy
**measured:** 0 · **proxy/est avoided:** 11 · **method:** proxy · **grokbot used (ledger):** 1 (**measured_ledger_not_platform**)

### CONTEXT
proxy chars **103392 → 16048** (not billed tokens)

### QUALITY
Deterministic math/hash success-equivalent **Y** where exercised; spacing paraphrase L3 hit **Y**; NL paraphrase brittle (**failure** without provider); repo/web **route-only**; S8 browser **Y** (safe public page)

### COST
ledger `estimated_usd_spent` **1.0000** (**measured_ledger_not_platform**); official Cursor usage **not_observable**

### SECURITY remaining
Path-escape tests **PASS** (**measured**). Gate B bare-operator residual. Preservation substring weakness for currency tokens (**observed**). CRITICAL F1/F2 cleared on candidate but must remain in disclosure history.

### READY TO PUBLISH?
**NO**

### SAFE PUBLIC CLAIMS
- CRITICAL F1/F2 existed at `fd9c017` and are verified non-reproducing on v0.1.1 `42f6da` (**measured**), without concealing the original defects.
- 163 tests / 19 files passed; 33/5/100% deterministic cold+warm benchmarks (**measured**).
- One controlled LIVE GrokBot browser success on this candidate via audit harness + desktop computerUse (Example Domains); ledger grokbot used 1; USD is **measured_ledger_not_platform**.
- Savings remain **proxy**; platform avoidance measured count is 0; Cursor usage **not_observable**.
- Website disclaimer present; site test count is stale vs measured.

### DO NOT CLAIM
- Ready to publish / full live-savings marketing package.
- Measured Cursor Usage & Billing or account $ savings.
- In-Bot or Edge as shipping products.
- “151 tests / 18 files” as current truth.
- Platform-measured savings (method is proxy).
- Audit bridge as customer-shipped bridge.
- Absolute always-cheaper / never-uses-GrokBot.
- Gate B fully cleared.
- Concealment or omission of CRITICAL F1/F2 at `fd9c017`.
- Counting historical `daeef390` bridge success as this candidate’s live run.
