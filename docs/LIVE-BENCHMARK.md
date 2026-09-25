# Live Benchmark

There are two benchmark layers, and they answer different questions.

## Layer 1 — the deterministic suite (33 fixtures, free)

```bash
grokmax benchmark                       # warm
GROKMAX_DB=/tmp/fresh.db grokmax benchmark   # cold
```

Five suites: `math` (20), `hash` (4), `escape` (5), `files` (2), `repo` (2).

**100% match** means every fixture produced its expected executor and matched
its expected output pattern. Note that 5 of the 33 are *escape* fixtures where
the correct behaviour is to decline. They count as matching, not as successful
resolutions. The benchmark says "100% match", not "100% of tasks solved".

Current state at v0.2.0-rc.1: **33/33, cold and warm, 0 GrokBot required.**

## Layer 2 — the live suite (7 scenarios, expensive)

`benchmarks/live/live-v1.json`. These cost real money, so the suite is kept to
seven scenarios. Six are designed to be completable *without* GrokBot; exactly
one exists to test the GrokBot path.

| id | class | GrokBot expected? |
| --- | --- | --- |
| `exact-repeat` | cache | no |
| `safe-paraphrase` | cache | no |
| `long-context-small-answer` | deterministic | no |
| `repo-analysis` | repository | no |
| `repo-modify-disposable` | repository | no |
| `current-research` | reasoning | no |
| `browser-auth-required` | browser | **yes** |

Every scenario declares explicit success criteria (`completed`,
`noGrokbotInvocation`, and usually a `summaryRegex`).

## Modes

| Mode | What it is |
| --- | --- |
| `native` | work goes straight to whatever the user or default route picks |
| `inbot` | GrokBot asks preflight first, then reuses/delegates/acts |
| `edge` | work is routed before GrokBot is considered at all |

## Contamination guards

The easiest way to make a routing benchmark lie is to compare a **warm** native
run against a **cold** edge run. That is blocked structurally.

### Manifests

```bash
grokmax bench manifest --name live-v1 --mode edge --cache-state cold \
  --task-fixture-version v1.0.0 --capability deterministic
```

A manifest pins mode, cache state, state reset, task fixture version, repo
fixture version, capability class, git SHA, and a content-derived **cache
namespace**. Cold and warm runs of the same suite always get *different*
namespaces, so one can never warm the other by accident.

### Comparison refuses mismatches

```bash
grokmax bench compare --a cold.json --b warm.json
COMPARABLE no
REASON     runs are not comparable: cache state: cold vs warm
```

A mode difference is allowed (that is the thing under test). A cache-state,
fixture-version, or capability-class difference is not.

### Cold runs must be honest

```bash
grokmax bench assert-cold --manifest cold.json --namespace-exists
# cold run live-v1 reused existing cache namespace bm-37db…;
# a cold run must start from an empty namespace
```

### Coding tasks use disposable fixtures

Repository scenarios must point at a path under a `fixtures` directory, and the
fixture is recreated from its `fixture.json` before every run:

```bash
grokmax bench reset-fixture --path benchmarks/fixtures/repo-min
reset fixture repo-min@repo-v1.0.0 (2 files)
```

This is what stops one mode's edits from making the next mode look better.

## Tests

`apps/cli/tests/manifest.test.ts` (27 tests) asserts cold/warm namespace
separation, comparison refusal, cold-state honesty, fixture-path safety, and the
structural integrity of the live-v1 suite.
