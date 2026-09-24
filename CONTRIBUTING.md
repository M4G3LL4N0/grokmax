# Contributing to GrokMax

GrokMax is MIT-licensed and open to contributions that make it more real, more
usable, more launchable, more reliable — or increase leverage.

## Core values

1. **Honesty over optimism.** Never present estimates as measurements. Never
   invent savings numbers.
2. **Deterministic-first.** Any task a cheaper worker can do cheaply must not
   route to GrokBot.
3. **Constraint preservation.** Hard constraints survive verbatim or the
   compile fails loudly.
4. **Graceful degradation.** A missing provider must degrade, not crash.

## Development

Requirements: Node >= 24, pnpm 8+.

```sh
pnpm install
pnpm lint          # eslint across the monorepo
pnpm typecheck     # tsc -p tsconfig.json --noEmit
pnpm vitest run    # 100+ tests
pnpm build         # tsup builds for all packages
```

Before any contribution is merged, **all four gates must pass**.

## Adding a fixture

Benchmarks live in `benchmarks/suites/<category>/<file>.json`. Each fixture is:

```json
{
  "id": "math-basic-add",
  "intent": "calculate",
  "goal": "Calculate 12+34",
  "expectedResolver": "deterministic",
  "expectedOutcomeRegex": "46"
}
```

Run `pnpm cli benchmark` to measure on your machine.

## Writing a test

Tests live next to their package under `packages/<pkg>/tests/`. We use vitest
with an in-memory or throwaway-tmpdir SQLite database — never touch the real
`data/grokmax.db`.

## Design contract

- The engine schedules; providers execute; the ledger records; telemetry
  computes — never the other way around.
- A route change must be accompanied by its cost-model assumptions and a
  `tests` change proving the new behavior.
- Cache keys are version-tainted (`grokmax-v0.1.0::…`). Changes that alter
  semantics must bump the version taint.

## Code review

Reviewers verify, per change:

- Does the documentation match the implementation? (Yes → merge.)
- Does this make a working product more real? (No → don't merge.)
- Are savings claims labeled correctly? (No → don't merge.)