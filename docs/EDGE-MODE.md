# Edge Mode

Edge Mode is the real GrokMax pipeline with one hard guarantee: **the work gets
done, and GrokBot is only touched when the router concludes that no other
executor can do the job.**

It is not a separate code path. `grokmax edge "<task>"` runs the same normalize →
cache → context → route → execute sequence as `grokmax optimize`, and then
applies a stricter honesty contract to the result.

## Running it

```bash
grokmax edge "Calculate 50+1"
grokmax edge "Calculate 50+1" --json
grokmax edge "Summarize the architecture" --summary-regex "^(?i)summary"
grokmax edge "Produce a report" --require-artifact
```

The process exits non-zero when the task did not complete, so a caller cannot
mistake a failure for a success.

## The completion contract

Edge Mode may only report a task as "GrokBot avoided" when **all** of these hold:

1. The worker reported success.
2. The outcome met the requested task contract.
3. GrokBot was not invoked.
4. Raw evidence is retained in the ledger and the returned structure.

A failed run is not an avoidance. A run that merely *could* have been done
elsewhere is not an avoidance. This is enforced in exactly one place —
`countedAsAvoided` in `packages/edge/src/index.ts` — so the rule is auditable
rather than distributed.

### Contract criteria

| Flag | Meaning |
| --- | --- |
| `--summary-regex <re>` | outcome summary must match |
| `--summary-contains <text>` | outcome summary must contain |
| `--min-evidence <n>` | at least N evidence items |
| `--require-artifact` | an artifact reference must be produced |

An invalid regex is treated as *unmet*, never as *passed*.

## Structured output

```json
{
  "mode": "edge",
  "taskId": "b483a565cfc79d13",
  "route": "deterministic",
  "routeReason": "deterministic-math resolvable locally with zero intelligence cost",
  "cacheState": "miss",
  "cacheLayer": null,
  "cacheChecks": [{ "layer": "L1", "hit": false, "reason": "no exact cache entry" }],
  "executor": "deterministic",
  "success": true,
  "status": "success",
  "grokbotRequired": false,
  "grokbotInvoked": false,
  "countedAsAvoided": true,
  "criteriaMet": true,
  "criteriaReason": "task completed and met the requested contract",
  "contextBefore": 2006,
  "contextAfter": 2006,
  "summary": "50+1 = 51",
  "evidence": ["deterministic math: 50+1 = 51"],
  "artifact": null,
  "measurement": {
    "contextReduction": "proxy",
    "externalCost": "estimated",
    "platformUsage": "unknown",
    "note": "Context reduction is a character-count proxy. ..."
  },
  "elapsedMs": 1904,
  "retries": 0,
  "errors": [],
  "runId": "b483a565cfc79d13"
}
```

### Measurement honesty in Edge output

| Field | Class | Why |
| --- | --- | --- |
| `contextReduction` | `proxy` | we count characters; we do not see billed tokens |
| `externalCost` | `estimated` | provider-reported, not an invoice |
| `platformUsage` | `unknown` | GrokBot platform usage is never observable from here |

`platformUsage` is **always** `unknown` in Edge output. A real platform number
can only come from a usage snapshot with class `measured_platform` — see
[PLATFORM-MEASUREMENT.md](./PLATFORM-MEASUREMENT.md).

## When GrokBot is genuinely required

If the router selects `grokbot`, Edge Mode invokes the configured bridge and
records the invocation honestly:

```
GROKBOT    required=true invoked=true
AVOIDED    no — see contract/grokbot lines
```

That is a correct result. Edge Mode's job is to prove the cheap path works, not
to avoid GrokBot at any cost.

## Public numbers

A sentence like "GrokMax avoided GrokBot on 5/6 eligible Edge tasks" is only
emitted when all six tasks completed, met their contract, and did not invoke
GrokBot. If any task failed, missed its contract, or invoked GrokBot, the
summary states the ratio **and** the reason it is not a clean sweep:

```
GrokMax avoided GrokBot on 5/6 eligible Edge tasks (1 task(s) did not complete).
Failed work is not counted as savings.
```

## Tests

`packages/edge/tests/edge.test.ts` (18 tests) and
`apps/cli/tests/modes.test.ts` cover:

- a task completed with zero GrokBot invocation
- a task that correctly invokes GrokBot when required
- a failed task is **not** counted as avoided
- a task that missed its contract is **not** counted as avoided
- artifact / evidence / regex criteria, including invalid regex failing closed
- summary aggregation refusing a clean ratio when any task failed
