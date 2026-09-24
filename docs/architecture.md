# Architecture

## Principle

**Deterministic-first.** Every task is pushed toward the cheapest capable
executor. GrokBot is the most expensive path and is used only when nothing
cheaper can satisfy the task.

## Pipeline

```text
TASK -> normalize -> fingerprint -> L0/L1 exact -> L2 normalized -> L3 semantic
     -> L4 artifact -> L5 knowledge -> slice context -> compile micro-prompt
     -> route -> execute -> compress -> save cache/artifact -> ledger
```

### 1. Normalize + Fingerprint (`packages/core`)

`normalize(text)` canonicalizes whitespace, unicode, and cased permutations so
“  Calculate   7*8 ” and “calculate 7*8” are the same task.

`fingerprint(text)` returns a hash over semantic tokens — not raw text — so
reordered wording still matches while distinct intents stay distinct.

### 2. Cache layers (`packages/cache`)

SQLite-backed (via `node:sqlite`), keyed by version-tainted fingerprints:

| Layer | Trigger | Cost |
| --- | --- | --- |
| L0 | in-memory LRU | 0 (~instant) |
| L1 | exact fingerprint hit | 0 |
| L2 | normalized-equivalence hit | 0 |
| L3 | semantic (cosine-similarity) hit | ~µs, local |
| L4 | reusable artifact ref (`contextRefs`) | 0 |
| L5 | durable knowledge rows (FAQ, docs) | 0 |

A cache hit returns the previously computed summary *without* invoking any
executor. Hits and misses are both recorded in `cacheLookups` so the reporting
is honest about what the cache actually did.

### 3. Context slicing (`packages/context`)

`sliceTaskContext(raw, { maxTokens })` returns the highest-signal subset of the
available context — typically ~1,500 tokens instead of tens of thousands. The
reduction is a **proxy** for token cost; it is never presented as a billed
measurement.

### 4. Micro-prompt compiler (`packages/compiler`)

`compile({ rawContext })` builds `CompiledPrompt` with:

- `preserved[]` — hard constraints kept **verbatim** and re-appended after the
  sliced context.
- `validation.preservedConstraints` — the list shown to the executor.
- `validatePreservation()` — fails loudly if a constraint token is lost.

The guarantee: a declared constraint may never silently disappear.

### 5. Router (`packages/router`)

`routeTask(task, available, ctx, costModel)` returns a `Route`:

```text
deterministic > api > chatgpt > opencode > grokbot
```

- **deterministic** — only when a `DETERMINISTIC_INTENTS` matcher (math, hash,
  file-count, git) actually matched, i.e. a *proven* resolvable task.
- **api / chatgpt** — when a provider is registered/available and budget fits.
- **opencode** — file-of-tree mutations (isRepoWork).
- **grokbot** — last resort; over budget and the only option → `none` (refuse,
  don’t pretend).
- Budget ceilings: `maxCostUsd`, `maxGrokBotUsage`.

### 6. Executors (`packages/adapters`)

- `DeterministicProvider` — local math parser (`evaluate`, no `eval`), hashing,
  file counting, `git status`, with zero spend and honest `costUsd = 0`.
- `OpenCodeProvider`, `ChatGPTProvider`, `GrokBotProvider`, `ApiProvider` —
  real bridge adapters that execute when budget/routing allows.

### 7. Telemetry (`packages/telemetry`)

`computeSavings(cachedRuns, grokBotRuns, opts)` returns honest numbers labeled
`measured | estimated | proxy`. Savings are **proxy** counts of avoided GrokBot
executions unless imported from live measurement.

### 8. Ledger, Artifacts, Knowledge (`packages/ledger`, `packages/artifacts`)

Every run is recorded in the ledger with its route, status, and cost. Successful
outputs can be stored in the L4 artifact store; extraction from artifacts feeds
the L5 knowledge store for future semantic reuse.

### 9. Doctor (`packages/doctor`)

`runDoctor(ctx)` probes every subsystem — Node, pnpm, git, sqlite, provider
availability, bridge, cache health — and returns a per-check status. A check is
only `ok` when it proves the thing it claims.

## Key structures

- `EngineDeps` — the engine’s contract to cache/ledger/artifacts/router/context
  (implemented by real packages; doubled in tests).
- `RunOutcome` — `{ taskId, route, status, executor, startTime, endTime,
  output, summary, costUsd, cacheLookups, savedByLayer }`.
- `RunOptions` — `{ dryRunOnly, skipCacheWrite, rawContext }`.

## Dependency direction

```text
apps/*
  -> pipeline (packages/core)
       -> router, context, compiler, adapters, cache, ledger, artifacts
            -> providers, telemetry
```

Nothing imports `apps/*` from `packages/*`. `packages/core` is the orchestration
hub; every other package depends on `@grokmax/core` types but never on each
other except where edges make structural sense.