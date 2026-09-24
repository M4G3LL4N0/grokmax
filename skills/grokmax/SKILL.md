---
name: grokmax
description: Minimize GrokBot usage while maximizing verified useful output. Use this skill whenever the user wants to cut their GrokBot spend, structure tasks so cheaper/deterministic work is done first, or run the GrokMax pipeline (context slicing, micro-prompt compilation, deterministic-first routing, layered caching) to handle a user request with the cheapest capable executor.
---

# GrokMax Skill

GrokMax is a deterministic-first execution pipeline for cutting GrokBot usage.

## How it works

1. **TASK** — the user describes what they want.
2. **CONTEXT** — pull the minimum context needed: referenced files, durable
   rules, dependencies. Send ~1,500 relevant tokens instead of 20,000.
3. **COMPILE** — build a micro-prompt that preserves hard constraints verbatim
   (they are appended to `selectedContext` and must survive verbatim).
4. **ROUTE** — pick the cheapest capable executor in order:
   `deterministic` > `api` > `chatgpt` > `opencode` > `grokbot`.
   Never send a task to GrokBot if a cheaper worker can do it.
5. **CACHE** — every result is cached by layer (L1 exact / L2 normalized /
   L3 semantic / L4 artifact / L5 knowledge) so identical or near-identical
   future tasks are served for zero cost.
6. **LEDGER** — every run is recorded with honest labels
   (measured / estimated / proxy). Savings are reported as proxies, never as
   platform measurements.

## When to use this skill

Use GrokMax when:

- The user asks you to save GrokBot usage, minimize spend, or "do it cheaper".
- A request is a math question, hashing task, file count, git query, or cache
  lookup (routable to `deterministic`).
- A request repeats — the answer is already in the cache.
- A repository change is requested and OpenCode is available (route `opencode`,
  not GrokBot).
- The user has a cleaner/cheaper tool that can do the job directly (`api`).

Do NOT use GrokMax when:

- The task genuinely requires GrokBot capabilities the bridge is built for:
  persistent computer control, authenticated browsing, plugin/routine
  automation, or ongoing interactive sessions. Those must still go to GrokBot.
- You are asked to misreport savings as measured when they are proxy estimates.
  Integrity is the product.

## Budget ceiling

The router respects hard ceilings:

- `maxCostUsd` — never exceed the dollar ceiling.
- `maxGrokBotUsage` — hard ceiling on GrokBot invocations per task.
- When the GrokBot route is over budget AND it is the only available worker,
  the router returns `none` rather than pretending to satisfy the task.

## Running GrokMax

From the repo root:

```sh
# full pipeline, prints plan + outcome
pnpm cli optimize "Calculate 7*8 and return the integer result"

# routing decision only
pnpm cli route "Refactor the scheduler module and add tests"

# plan without executing anything
pnpm cli dry-run "Fix the typecheck error in src/main.ts"

# health checks across all subsystems
pnpm cli doctor

# cache stats / prune / clear
pnpm cli cache stats
pnpm cli cache prune

# honest savings report (proxy or measured)
pnpm cli savings

# benchmark fixtures (measured on THIS machine, deterministic-only)
pnpm cli benchmark
```

## The honesty rules

1. Savings are always labeled **proxy** unless imported from live measurement.
2. Context reduction is a **proxy** for token cost, never a billed measurement.
3. We never claim to measure native GrokBot usage; the platform does not expose
   it.
4. When only a proxy is available we say so explicitly.

## Constraints diagram

Compiler guarantees: if the task declares hard constraints (for example
`pnpm only`, `never deploy to prod`), they appear **verbatim** in the final
prompt. `validatePreservation` flags any constraint token lost during
compression — a constraint may never silently disappear.

```text
TASK ─▶ normalize ─▶ fingerprint ─▶ L0/L1 exact ─▶ L2 normalized ─▶ L3 semantic
     ─▶ L4 artifact ─▶ L5 knowledge ─▶ slice context ─▶ compile micro-prompt
     ─▶ route ─▶ execute ─▶ compress ─▶ save cache/artifact ─▶ ledger
```

## Current status

- Node >= 24 (uses `node:sqlite`), pnpm-based monorepo, MIT license.
- 10+ packages, deterministic-first router, 5 layered caches, honest
  telemetry, 100% benchmark resolve/outcome accuracy across shipped fixtures.
- The GrokBot bridge connects via `GROKMAX_GROKBOT_BRIDGE` and is treated as
  LAST in the route priority because it is the most expensive execution path.