# GrokMax v0.1.1 — Independent Adversarial Verification (GrokBot)

> **Later candidate (section 13 — does not replace this record):** v0.2.0-rc.1 `e3541d8e80319cdf623f73dea7e1c80d48983fa7` — **READY TO PUBLISH? = NO**. Sections 1–12 and the v0.1.1 scorecard below stay as the historical record, including **CRITICAL F1/F2 at `fd9c017`** and **Gate B 21/22** with bare-operator **`FAIL_UNSAFE_HIT`**.

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

---

# 13. v0.2.0-rc.1 — independent adversarial audit (`e3541d8`)

**Publication decision for this candidate:** **NOT READY** (`READY TO PUBLISH?` = **NO**)  
**Evidence recorded from:** independent adversarial audit measured 2026-09-24 (America/Denver); claim adjudication `2026-09-24T20:59:44-06:00`  
**Core candidate:** `e3541d8e80319cdf623f73dea7e1c80d48983fa7` (tag **v0.2.0-rc.1**)  
**Parent:** `f9a320b8548e7559cbf79f3c2c78be91377eeae7`  
**Website (read-only):** `b7c047e317dae73f77cb6c883066b9b3dfcfbdf8`  
**Workdir (audit clone):** `/tmp/grokmax-v02-rc1-verify` · product source **not** modified  
**Policy:** Trust the attached measured JSON, not commit-message marketing. Prefer false-negative over unsafe hit. Do not invent platform usage. Do not conceal original CRITICAL defects. This section is appended. Sections 1–12 are unchanged historical record.

Machine companion for the current candidate: `benchmarks/results/summary.json` (top-level = this candidate; `history` retains prior SHAs and the full v0.1.1 publication summary).

---

## 13.1 What this section does not erase

The embarrassing record stays visible above and in `benchmarks/results/summary.json` → `history`.

| SHA | What remains on the record | Label |
|---|---|---|
| `fd9c017981d5aa96eb36aed6b5ca8da5b578b0f6` | **CRITICAL F1** — L3 hit confidence 1.000 returned `7*8 = 56` for probes `Calculate 50+1` and `Calculate 500+1`. **CRITICAL F2** — negation/budget L3 collision reused the opposite intent (`UNSAFE_F2: true`). Related HIGH F5: `validatePreservation` dropped negation tokens (`ok: true`). | historical, reproduced measured |
| `daeef3907b512e1dc339b332c15761c08f202eb8` | PR #1 remediation. Bridge job `20260924T120308-1109200-8505` is **historical only** and is not this candidate’s live count. | historical |
| `42f6da543af04a4eb1adbf4fe11bb82dc2b599cc` (v0.1.1) | Gate B **21/22**, **1 FAIL_UNSAFE_HIT** (bare `Use operator +` ↔ `Use operator *`). `validatePreservation(["budget $50"], "budget $500…")` still **`ok: true`** because `$50` ⊂ `$500`. Tests **163 / 19**. In-Bot and Edge **`NOT_IMPLEMENTED` / `missing_product`**. Website claimed **151 / 18** vs measured **163 / 19**. **READY TO PUBLISH? = NO**. | historical (sections 1–12) |
| `f9a320b8548e7559cbf79f3c2c78be91377eeae7` | Parent of this candidate. Commit text talks about bare-operator and `$50`/`$500` honesty. **This audit does not treat that commit message as the measurement.** The measurements below are on child `e3541d8`. | parent SHA |
| Website claim lineage | **151 → 163 → 170 → 279**, as preserved by the audit scorecard. **151** was the site claim at the v0.1.1 audit; **163** was measured then; **279 / 26** is measured on this candidate. **170** is recorded lineage, not re-measured in this refresh. | historical lineage |

Empty `CRITICAL: []` on **this** candidate means no new CRITICAL defect was opened at `e3541d8`. Historical F1/F2 at `fd9c017` remain the baseline record in section 2 and in the table above.

---

## 13.2 Tests and regression (measured)

| Check | Result | Label |
|---|---|---|
| `pnpm test` | **279 passed / 26 files / 0 failed** | measured |
| `pnpm lint` | exit 0 | measured |
| `pnpm typecheck` | exit 0 | measured |
| `pnpm install` | exit 0 | measured |
| F1 `Calculate 50+1` vs `Calculate 500+1` | lookup `probeHit: false`, `compatible: false`, engine `UNSAFE: false` | measured **PASS** |
| F2 deploy negation and budget `$50` ↔ `$500` (both directions, including “Budget is $50 for the task”) | lookup unsafe count 0, engine unsafe count 0 | measured **PASS** |
| `validatePreservation(['budget $50'], 'budget $500 for the task')` | **`ok: false`**; lost constraint `budget $50` (token `50`) | measured |
| `--fresh` after warm L1 hit on `Calculate 17+4` | two `--fresh` runs `cacheLayer: MISS`; no L4/L5 prior | measured **PASS** |
| Path containment (`../etc`, `../../etc`, `/etc`, encoded dots, symlink escape) | all rejected | measured **PASS** |

The v0.1.1 residual `ok: true` via `$50` ⊂ `$500` is the historical finding in section 4. On `e3541d8` the same class of call measures **`ok: false`**.

---

## 13.3 Gate B

Two different suites. Both measured on `e3541d8`. The v0.1.1 **21/22** failure stays in this table and in sections 4–5.

| Suite | At v0.1.1 `42f6da` (retained) | On `e3541d8` (this audit) |
|---|---|---|
| Historical adversarial Gate B (22 cases) | **21/22 PASS**, bare `+`/`*` **FAIL_UNSAFE_HIT** | **22/22 PASS**, unsafe semantic hits **0** |
| Bare `Use operator +` ↔ `Use operator *` | **FAIL_UNSAFE_HIT** | **PASS_MISS** (`probeHit: false`, `compatible: false`, `reusedSeedEcho: false`, `expectMiss: true`) |
| Reconstructed threat-pair Gate B | not this row | **42/42 PASS** — 14 `THREAT_PAIRS` × 3 checks (compat false + forward lookup miss + reverse lookup miss); 0 unsafe semantic hits. The “42” figure is that reconstruction; the repo has no separate literal `42` constant. |

---

## 13.4 Edge Mode

**Implemented:** true. **Verified:** true. Real pipeline: `edge` → `engine.run(task, {rawContext})` → `buildEdgeResult`. Package doc observed: Edge Mode is the real GrokMax pipeline.

Reduced live batch only. Failures are not counted as avoidance.

| Scope | Successful eligible avoidance | What is in the fraction |
|---|---|---|
| Primary | **2/3** | Exact cold + exact warm avoided. Browser success invoked GrokBot (in the denominator, not the numerator). Safe-paraphrase failure excluded. |
| With optional math | **4/5** | Optional `9876+5432` cold+warm also avoided. |

| Scenario | Verdict | Notes |
|---|---|---|
| A deterministic cold `1234+5678` | **PASS** | route `deterministic`, `grokbotInvoked: false`, `countedAsAvoided: true`, summary `1234+5678 = 6912` |
| B exact warm | **PASS** | cache hit L0, `countedAsAvoided: true` |
| C safe paraphrase (“Compute 1234 plus 5678”) | **HONEST_FAIL_NO_GROKBOT** | L3 miss, deterministic resolver did not match, `success: false`, `countedAsAvoided: false`. Not semantic reuse. |
| D repository / OpenCode | **not_run_missing_tool** | OpenCode CLI absent. `routeReason` / route JSON: `opencode unavailable`. Do not fake success. |
| E example.com title | **PASS_HANDOFF** | route `grokbot` because **`opencode unavailable`**, `grokbotInvoked: true`, `countedAsAvoided: false`. Audit bridge job `20260924T204627-1286233-3639`. Title `Example Domain`. |

`measurement.platformUsage` is **`unknown`** on every Edge JSON row (hardcoded in `buildEdgeResult`). That field is not a platform-usage measurement.

Caveats that travel with the 2/3 figure: safe-paraphrase fail excluded; OpenCode absent; browser `routeReason` often `opencode unavailable`.

---

## 13.5 In-Bot Mode

**Implemented:** true. **Verified:** true. Skill wrapper is executable (exit 0 and a valid action enum on cache return).

Preflight path observed: `preflight` → `engine.run(task, {dryRunOnly: true})` → `findExistingResult` → `@grokmax/inbot` `preflight()`. `verifyInbotInvocation` pairs a later GrokBot run with a prior `GROKBOT_REQUIRED` preflight.

| Effect | Measured |
|---|---|
| `RETURN_EXISTING_RESULT` | `grokbotWorkRequired: false`. Reused `42+7 = 49` from cache. Ledger worker null. Not re-executed. |
| `DELEGATE` | deterministic delegate, `grokbotWorkRequired: false`, micro-prompt present. Repo/OpenCode and advisory/ChatGPT lanes **FAIL** closed as missing tools — not faked as `DELEGATE`. |
| `GROKBOT_REQUIRED` | `grokbotWorkRequired: true`. Without a bridge: **FAIL_CLOSED**. With the audit bridge: handoff, job `20260924T204953-1290479-3190`, title `Example Domain`, `countedAsAvoided: false`. |
| `verifyInbotInvocation` | **`verified: true`** — GrokBot run `95f4ef4c6a6eb0e5` followed `GROKBOT_REQUIRED` preflight task `b93d6e18fbf6ddb2`. Negative checks (delegate preflight, flag mismatch) correctly `verified: false`. |

In-Bot does not mean zero GrokBot. GrokBot must call preflight. `GROKBOT_REQUIRED` still invokes GrokBot.

On the later NATIVE / IN-BOT / EDGE experiment, In-Bot actions observed were `RETURN_EXISTING_RESULT` 2, `DELEGATE` 3, `GROKBOT_REQUIRED` 1 (`grokbotWorkRequired` false on 5, true on 1).

---

## 13.6 Platform usage, ledger, context, external cost

**Cursor platform usage reduction could not be quantified at sufficient resolution.**

| Item | Status | Label |
|---|---|---|
| Cursor platform usage | **`not_observable`** | measured absence |
| Allowed sentence | Cursor platform usage reduction could not be quantified at sufficient resolution. | exact |
| Why | No billing API in product; no measured_platform before/after pair this audit; Matador offline; Usage & Billing was not browsed (that would contaminate the measurement); no invented token or USD estimates | observed |
| Ledger vs platform | Separate. Never merge `measured_ledger` with `measured_platform`. Edge `platformUsage` is always `unknown`. | observed |
| Context | Character proxies only where present. Not billed tokens. | proxy |
| External cost | **unknown** (no invoice) | unknown |

Experiment ledger rows exist and stay labeled `measured_ledger` (native grokbot used 1 / estimated USD 1.0000; in-bot grokbot used 2 / estimated USD 2.0000, including preflight dry-run rows; edge grokbot used 1 / estimated USD 1.0000). `grokbot-avoided (measured)` on those ledgers is **0**. Estimated USD is not Cursor Usage & Billing.

---

## 13.7 Live GrokBot

Live browser completions in Steps 3, 4, and 6 are **audit bridge only**.

| Field | Value |
|---|---|
| Label | **`audit_bridge_not_customer_product`** (also recorded as `measured_audit_bridge`) |
| What ran | Audit-bridge browser jobs for the example.com title |
| Completer | Public HTTP fetch (`scripts/bridge-completer.sh`), not a customer desktop GrokBot `computerUse` session |
| Customer desktop GrokBot | **not** what was measured |

The v0.1.1 live run (section 7, job `20260924T134606-1153001-31567`, `computerUse_box_desktop`) remains that candidate’s historical live count. It is not reclassified as this candidate’s customer-desktop proof.

---

## 13.8 Quality — NATIVE / IN-BOT / EDGE

Controlled experiment, separate database per mode. Cold→warm inside a mode shares that mode’s database. Modes keep separate databases. Product code was not modified. The reduced suite is what ran; full live-v1 stayed blocked.

| | NATIVE | IN-BOT | EDGE |
|---|---|---|---|
| Primary success | **3/4** | **3/4** | **3/4** |
| With optional math | **5/6** | **5/6** | **5/6** |

Primary quality is equal across the three modes: **3/4**. The shared failure is live-v1 **safe-paraphrase** (worded “plus”): deterministic miss, no L3 hit, in **NATIVE, IN-BOT, and EDGE**. It is not counted as savings.

Skipped scenarios:

| Scenario | Label | Reason |
|---|---|---|
| long-context small answer | `not_run_missing_tool` | OpenCode CLI absent |
| repo analysis | `not_run_missing_tool` | OpenCode CLI absent |
| repo modify (disposable) | `not_run_missing_tool` | OpenCode CLI absent |
| current research | `not_run` | ChatGPT unset (`GROKMAX_CHATGPT_API_KEY` absent) |

Browser routing in this batch was not cleanly isolated from OpenCode absence: `routeReason` is often `opencode unavailable`, and the task then falls through to `grokbot` when the audit bridge is present.

---

## 13.9 Claim adjudication (Step 11)

**ChatGPT adjudication: unavailable.** Connector was down. The adjudicator is an **independent auditor second-opinion substitute**, not a ChatGPT product. Note recorded with the adjudication: “ChatGPT connector unavailable; adjudication from measured evidence only — not a ChatGPT product.” No material test-plan changes came from ChatGPT. The reduced suite is the one that could be run with OpenCode and ChatGPT absent.

### SAFE PUBLIC CLAIMS

Copied from the audit scorecard / Step 11 tightened wording:

1. 279 tests across 26 files measured locally on e3541d8 (v0.2.0-rc.1), reproducible via pnpm test
2. Historical adversarial Gate B 22/22 PASS; reconstructed threat-pair Gate B 42/42 PASS; bare +/* PASS_MISS; 0 unsafe semantic hits on e3541d8
3. Original CRITICAL F1/F2 unsafe cache hits at fd9c017 were reproduced historically and remain PASS on e3541d8
4. Edge Mode runs the real pipeline (engine.run→buildEdgeResult). On the reduced live batch, 2/3 successful eligible Edge tasks avoided GrokBot (exact cold+warm); failures not counted
5. In-Bot preflight can RETURN_EXISTING_RESULT or DELEGATE with grokbotWorkRequired=false; GROKBOT_REQUIRED pairs with verifyInbotInvocation. Does not claim zero GrokBot
6. Public site claiming 279/26 matches measured suite; Modes labeled verification candidate is appropriate until OpenCode lanes complete

### DO NOT CLAIM

Copied from the audit scorecard / Step 11 tightened wording:

1. Do not claim 6/7. Measured reduced suite only: Edge successful-eligible avoidance 2/3 (primary) or 4/5 with optional math
2. live-v1 safe-paraphrase failed in NATIVE/IN-BOT/EDGE (deterministic miss, no L3 hit). Do not claim paraphrase reuse works
3. Never claim. GrokBot must call preflight; GROKBOT_REQUIRED still invokes GrokBot
4. Cursor platform usage reduction could not be quantified at sufficient resolution.
5. Live browser completions used an audit bridge completer (public HTTP), not a customer desktop GrokBot session
6. Edge and In-Bot are independently verified for deterministic/cache/preflight/bridge-handoff paths. Repository/OpenCode lanes and ChatGPT advisory lanes were not_run. Browser GrokBot routing was not cleanly isolated from OpenCode absence

Also still do not claim: concealment or omission of CRITICAL F1/F2 at `fd9c017`; that Gate B was “always clear” (the **21/22** bare-operator era is real); that v0.1.1 In-Bot/Edge absence did not happen; that ledger USD is Cursor billing.

---

## 13.10 Findings and blockers on this candidate

**CRITICAL (new, this candidate):** none.

**HIGH (this audit):**

1. live-v1 safe-paraphrase fails all modes — the suite overclaims if published as completable without GrokBot.
2. OpenCode CLI absent — full live-v1 blocked; browser→grokbot often due to `opencode unavailable`.
3. `docs/GROKBOT-VERIFICATION.md` in-repo was stale versus measured (**pre-update**). This section and the `summary.json` refresh are that documentation update. The staleness finding stays in the record as what the audit observed before the refresh.

**Smallest remaining blockers:**

| ID | Owner | Blocker |
|---|---|---|
| B1 | OpenCode / engineering | Install/configure OpenCode CLI and re-run live-v1 repo + long-context lanes; re-check browser `GROKBOT_REQUIRED` isolation when OpenCode is present |
| B2 | OpenCode / engineering | Fix or remove live-v1 safe-paraphrase (worded “plus”) so the suite does not claim a path that fails in all modes |
| B3 | auditor + OpenCode | Refresh `docs/GROKBOT-VERIFICATION.md` and `benchmarks/results/summary.json`, preserving `fd9c017` CRITICAL history and the new v0.2 measurements |

B3 is the documentation refresh this section performs. **B1 and B2 remain open.** **READY TO PUBLISH? = NO.**

---

## 13.11 Evidence roots (audit workspace, not product source)

| Artifact | Path |
|---|---|
| Decision memo | `/workspace/grokmax-audit/v02-candidate/chatgpt-decision-memo.json` |
| Step 1 candidate | `/workspace/grokmax-audit/v02-candidate/STEP1-CANDIDATE.json` |
| Regression | `/workspace/grokmax-audit/v02-candidate/regression` |
| Edge | `/workspace/grokmax-audit/v02-candidate/edge` |
| In-Bot | `/workspace/grokmax-audit/v02-candidate/inbot` |
| Platform | `/workspace/grokmax-audit/v02-candidate/platform` |
| Experiment | `/workspace/grokmax-audit/v02-candidate/experiment` |
| Claim adjudication | `/workspace/grokmax-audit/v02-candidate/STEP11-CLAIM-ADJUDICATION.json` |

---

## SCORECARD — v0.2.0-rc.1

The v0.1.1 scorecard above this section is retained.

### RELEASE CANDIDATE
v0.2.0-rc.1 @ `e3541d8e80319cdf623f73dea7e1c80d48983fa7` · parent `f9a320b8548e7559cbf79f3c2c78be91377eeae7` · website `b7c047e317dae73f77cb6c883066b9b3dfcfbdf8`

### REGRESSION
Original **CRITICAL F1/F2 at `fd9c017` remain in the historical record** and measure **PASS** on this candidate (no unsafe cache reuse). Historical adversarial Gate B **22/22**. Threat-pair reconstruction **42/42**. Bare `+`/`*` **PASS_MISS**. `$50` ⊂ `$500` preservation **`ok: false`**. The v0.1.1 era **21/22 FAIL_UNSAFE_HIT** and **`ok: true`** substring residual stay recorded in sections 4–5.

### TESTS
**279** passed / **26** files / **0** failed (**measured**)

### EDGE
**implemented + verified**. Successful eligible avoidance **2/3 primary** (**4/5** with optional math). Safe-paraphrase **fail** (excluded from the avoidance numerator). OpenCode **missing** for repository lanes.

### IN-BOT
**implemented + verified**. `RETURN_EXISTING_RESULT` / `DELEGATE` / `GROKBOT_REQUIRED` observed. `verifyInbotInvocation` **true** on the paired GrokBot handoff. Does not claim zero GrokBot.

### PLATFORM
**not_observable.** Cursor platform usage reduction could not be quantified at sufficient resolution.

### LIVE GROKBOT
Audit bridge only (`audit_bridge_not_customer_product`). Public HTTP completer for example.com. Not a customer desktop GrokBot session.

### QUALITY
Primary **3/4** success, equal across **NATIVE / IN-BOT / EDGE**. Paraphrase fails in all three modes.

### CHATGPT ADJUDICATION
**Unavailable.** Auditor substitute in Step 11. Not a ChatGPT product.

### COST
External cost **unknown** (no invoice). Ledger USD is `measured_ledger`, separate from platform.

### READY TO PUBLISH?
**NO**

### BLOCKERS STILL OPEN
**B1** OpenCode CLI and repo/long-context lanes. **B2** safe-paraphrase fails in every mode. **B3** is this documentation refresh.
