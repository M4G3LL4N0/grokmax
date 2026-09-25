# Reproducing a Live Benchmark

This is the exact procedure for a reproducible native / inbot / edge comparison.
Follow it literally; the contamination guards assume you do.

## Prerequisites

- Node >= 24, pnpm installed, `pnpm install` completed
- A checked-out `grokmax` at the SHA you intend to test
- Record the SHA: `git rev-parse HEAD`
- Record the suite version and task fixture version from
  `benchmarks/live/live-v1.json`

## 1. Record platform usage BEFORE

Only if you actually have the platform UI open. Otherwise record nothing and
your final report will correctly say `platform usage: unknown`.

```bash
export GROKMAX_DB="$PWD/data/live.db"
grokmax usage snapshot add \
  --label "before-$(date +%Y%m%d-%H%M%S)" \
  --source cursor-ui \
  --capture-method browser-observed \
  --measurement-class measured_platform \
  --kind weeklyIncludedUsagePct --value "<the number you see>" --unit '%' \
  --precision displayed
```

## 2. Record the same platform usage AFTER

Identical `--source` and `--measurement-class`. If the class differs, the diff
will refuse, which is the intended behaviour.

## 3. Create one isolated experiment session per mode

```bash
SHA=$(git rev-parse HEAD)

grokmax experiment create "native-cold-$SHA" --mode native --cache-state cold \
  --task-fixture-version v1.0.0 --repo-fixture-version repo-v1.0.0 --git-sha "$SHA"

grokmax experiment create "inbot-cold-$SHA" --mode inbot --cache-state cold \
  --task-fixture-version v1.0.0 --repo-fixture-version repo-v1.0.0 --git-sha "$SHA"

grokmax experiment create "edge-cold-$SHA" --mode edge --cache-state cold \
  --task-fixture-version v1.0.0 --repo-fixture-version repo-v1.0.0 --git-sha "$SHA"
```

Each session gets its own `dbNamespace` and `cacheNamespace`. Never reuse one
DB across modes for a comparison.

## 4. Build and compare manifests

```bash
for mode in native inbot edge; do
  grokmax bench manifest \
    --name live-v1 --mode "$mode" --cache-state cold \
    --state-reset fresh-namespace \
    --task-fixture-version v1.0.0 \
    --repo-fixture-version repo-v1.0.0 \
    --repo-fixture-path benchmarks/fixtures/repo-min \
    --capability deterministic --git-sha "$SHA" > "$mode-cold.json"
done

grokmax bench compare --a native-cold.json --b edge-cold.json
# COMPARABLE yes  (mode differs, which is intended; everything else matches)
```

If this says `COMPARABLE no`, stop. You changed a fixture version or cache
state by accident and the comparison would be meaningless.

## 5. Reset the fixture repo before every coding scenario

```bash
grokmax bench reset-fixture --path benchmarks/fixtures/repo-min
```

## 6. Run each scenario, recording honestly

Edge mode:

```bash
grokmax edge "Calculate 1234+5678 and return the integer result" --json
grokmax experiment record "edge-cold-$SHA" exact-repeat \
  --status success --executor deterministic --cache-state cold \
  --elapsed-ms <n> --no-grokbot-invoked
```

In-Bot mode — the GrokBot skill calls preflight first:

```bash
node skills/grokmax/inbot.mjs "Calculate 1234+5678 and return the integer result" --json
```

For the browser scenario, expect `GROKBOT_REQUIRED` and record the invocation:

```bash
grokmax experiment record "edge-cold-$SHA" browser-auth-required \
  --status success --executor grokbot --grokbot-required --grokbot-invoked \
  --cache-state cold --elapsed-ms <n>
```

Record failures as failures:

```bash
grokmax experiment record "edge-cold-$SHA" current-research \
  --status failure --no-success --cache-state cold
```

## 7. Report

```bash
grokmax experiment report "edge-cold-$SHA"
grokmax experiment report "native-cold-$SHA"
```

The report shows `eligible tasks`, `genuine avoidances`, `grokbot invocations`,
and `failures`. A failed task reduces `genuine avoidances`; it is never counted
as a saving.

## 8. Diff the platform usage (only if you recorded both snapshots)

```bash
grokmax usage snapshot list
grokmax usage snapshot diff <beforeId> <afterId>
```

If either snapshot is `proxy` or `estimated`, the claim is
`platform usage: unknown`. That is the correct output, not a failure to fix.

## Deterministic suite (free, always run)

```bash
GROKMAX_DB=/tmp/cold.db grokmax benchmark   # cold
grokmax benchmark                            # warm
```

Both must show 33/33 with 0 GrokBot required.

## Gates before trusting any of this

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm run doctor
```

At v0.2.0-rc.1: 279 tests across 26 files, Gate B 42/42, 0 unsafe semantic hits.
