# GrokMax

**Minimize GrokBot usage while maximizing verified useful output.**

GrokMax is a deterministic-first execution pipeline for GrokBot: it routes every
task to the cheapest capable executor, slims the context to what matters, and
caches the result across five layers so nothing is paid for twice.

```text
TASK -> normalize -> fingerprint -> L0/L1 exact -> L2 normalized -> L3 semantic
     -> L4 artifact -> L5 knowledge -> slice context -> compile micro-prompt
     -> route -> execute -> compress -> save cache/artifact -> ledger
```

Route priority (mission order):

```text
deterministic > api          > chatgpt        > opencode        > grokbot
zero-cost     > direct tool  > research/cheap > repo work       > persistent/authed
```

## Why

GrokBot is the most capable executor — and the most expensive one. Most tasks on
any given day are not GrokBot-only tasks. They are:

- math (`Calculate 7*8`), hashing (`sha256 of …`), file counts, `git status`
- cached answers to questions asked yesterday
- repository edits that any capable coding agent can do more cheaply
- lookups a direct API does in milliseconds

GrokMax catches those *before* they become GrokBot invocations.

## Key properties

| Property | What it means |
| --- | --- |
| Deterministic-first | Zero-cost local executors handle math/hash/count/git before anything costs money. |
| 5-layer cache | L1 exact, L2 normalized, L3 semantic, L4 artifact, L5 durable knowledge. |
| Context slicing | Sends ~1,500 relevant tokens instead of 20,000. Reductions are a **proxy** for token cost, never a billed measurement. |
| Constraint preservation | Hard constraints survive verbatim into the final prompt; `validatePreservation` flags any loss. |
| Budget ceilings | `maxCostUsd` and `maxGrokBotUsage` are hard ceilings. Over-budget GrokBot routes refuse rather than pretend. |
| Honest telemetry | Every number is labeled **measured / estimated / proxy** in the ledger. Savings are proxies unless imported from live measurement. |
| Graceful degradation | No provider, no problem — routing returns `none` and the pipeline reports it plainly. |

## Quick start

Requirements: Node **>= 24** (uses `node:sqlite`), `pnpm` 8+.

```sh
git clone https://github.com/M4G3LL4N0/grokmax.git
cd grokmax
pnpm install
pnpm cli doctor          # health check across every subsystem
pnpm cli benchmark       # measured on THIS machine; deterministic-only, no spend
```

```sh
pnpm cli optimize "Calculate 7*8 and return the integer result"
# ROUTE  DETERMINISTIC
# ...    7*8 = 56   (zero cost, cached for the next identical ask)

pnpm cli route "Refactor the scheduler module and add tests"
# ROUTE  OPENCODE
# GROKBOT not required

pnpm cli dry-run "Fix the typecheck error in src/main.ts"
# ROUTE  OPENCODE   -> SKIPPED  (plan only; nothing executed)

pnpm cli savings
# honest report across your ledger runs (proxy unless measured)
```

## CLI reference

| Command | Description |
| --- | --- |
| `grokmax optimize "<goal>"` | Full pipeline: plan + outcome. |
| `grokmax run <intent> <goal>` | Explicit intent + goal. |
| `grokmax ask "<question>"` | Shorthand: intent = goal = question. |
| `grokmax route "<goal>"` | Routing decision only (never executes). |
| `grokmax dry-run "<goal>"` | Plan without executing anything. |
| `grokmax explain <runId>` | Inspect a specific run in the ledger. |
| `grokmax cache stats\|prune\|clear` | Cache health / maintenance. |
| `grokmax usage` | Ledger summary, honestly labeled. |
| `grokmax savings` | Savings report (`--json` for machine-readable). |
| `grokmax benchmark` | Run fixture suites, measured locally. |
| `grokmax doctor` | Health checks across every subsystem. |
| `grokmax status` | One-view aggregate (doctor + cache + ledger + savings). |

Add `--json` to any command for machine-readable output. By default the
database lives at `data/grokmax.db`; override with `GROKMAX_DB`.

## Repo layout

```text
app/
  cli/              commander-based CLI (optimize/run/ask/route/dry-run/benchmark/doctor/…)
packages/
  core/             engine, types, normalize, fingerprint, pipeline
  cache/            SQLite-backed L0–L5 cache fabric
  adapters/         provider adapters (deterministic/opencode/chatgpt/grokbot/api)
  context/          context slicer
  compiler/         micro-prompt compiler + constraint preservation
  router/           deterministic-first router + cost model
  ledger/           usage ledger with honest measurement labels
  artifacts/        L4 artifact store + L5 knowledge store
  providers/        provider contracts + registry
  telemetry/        honest savings computation
  doctor/           subsystem health checks
benchmarks/
  suites/           5 fixture categories, 33 tasks (math / repo / hash / files / escape)
skills/
  grokmax/SKILL.md  the reusable GrokBot skill
```

## Honesty policy

This project’s integrity is its product. Savings numbers are:

- **measured** – only when manually imported from live usage observation.
- **estimated** – cost/token estimates marked as such everywhere.
- **proxy** – router-level avoided-GrokBot counts and context reductions.
  Useful, directional, and never presented as platform-anonymous measurements.

## Roadmap

- [x] Monorepo + 11 subsystem packages
- [x] CLI, doctor, benchmark, honest telemetry
- [x] Reusable GrokBot skill
- [ ] REPL / daemon mode
- [ ] Live GrokBot usage import (manual measured bridge)

## License

MIT. See [LICENSE](LICENSE).