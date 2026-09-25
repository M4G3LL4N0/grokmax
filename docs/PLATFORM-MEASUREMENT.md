# Platform Measurement

**There is no Cursor or GrokBot billing API.** Nothing here scrapes, reverse
engineers, or calls a private endpoint. Everything recorded is an observation a
human made, usually by reading a number off a screen, and every row carries the
provenance that makes it auditable.

## Measurement classes

Every snapshot declares exactly one class. It is never inferred from the shape
of the data and never upgraded.

| Class | What it means |
| --- | --- |
| `measured_platform` | read directly off the platform's own usage/billing UI |
| `measured_ledger` | imported from an actual provider ledger/CSV export |
| `proxy` | inferred by GrokMax from routing decisions; **not** platform usage |
| `estimated` | a model-based estimate |
| `unknown` | we do not know |

A `proxy` row stays a `proxy` forever.

## Sources and capture methods

`--source` — where the number came from:
`cursor-ui`, `grokbot-ui`, `billing-page`, `csv-export`, `api`, `manual`, `unknown`

`--capture-method` — how it was obtained:
`manual`, `browser-observed`, `screenshot`, `csv-import`, `api-read`, `derived`, `unknown`

## Precision

`--precision` records how precisely the number was actually observed:

| Precision | Meaning |
| --- | --- |
| `displayed` | the UI showed the figure; this is what it said |
| `range` | only a band is known (e.g. "between 40% and 60%") |
| `derived` | computed rather than read |
| `unknown` | no usable value |

A coarse percentage is stored as a coarse percentage. We never back-solve a
displayed percentage into a token count, request count, or dollar amount — the
store **rejects** such submissions:

```
$ grokmax usage snapshot add ... --kind requests --precision derived
derived request counts are not accepted; record only what the platform displayed
```

## Recording an observation

```bash
grokmax usage snapshot add \
  --label week-1 \
  --source cursor-ui \
  --capture-method browser-observed \
  --measurement-class measured_platform \
  --kind onDemandUsd --value 12.50 --unit usd --precision displayed

grokmax usage snapshot add \
  --label week-1-pct \
  --source cursor-ui \
  --capture-method browser-observed \
  --measurement-class measured_platform \
  --kind weeklyIncludedUsagePct --value 60 --unit '%' --precision displayed
```

For a range observation, add the bounds:

```bash
  --kind weeklyIncludedUsagePct --value 50 --unit '%' \
  --precision range --range-low 40 --range-high 60
```

## Listing and diffing

```bash
grokmax usage snapshot list
grokmax usage snapshot diff <beforeId> <afterId>
```

### Diffs refuse to cross classes

```bash
$ grokmax usage snapshot diff a12e… 1b55…
COMPARABLE  no
CLASS      mixed
REASON     measurement classes differ (measured_platform vs proxy); a difference
           between classes is not a measurement
CLAIM      platform usage: unknown
```

Subtracting a proxy from a platform measurement produces a number that means
nothing, so the tool refuses instead of printing it.

### Only measured_platform yields a platform claim

```
$ grokmax usage snapshot diff a12e… 38ca…
COMPARABLE  yes
CLASS      measured_platform
REASON     both snapshots are measured_platform observations of the same account
  - onDemandUsd: 12.5 -> 3.5 (delta -9usd)
CLAIM      platform usage (measured_platform): onDemandUsd -9
```

A `proxy` or `measured_ledger` diff produces the correct number internally but
its public claim is `platform usage: unknown`, because neither is the platform's
own billing surface.

## What may be claimed

| Statement | Requirement |
| --- | --- |
| "avoided GrokBot on 5/6 eligible Edge tasks" | 5 tasks completed, met contract, no GrokBot invocation, raw evidence retained |
| "reduced weekly usage by X" | two `measured_platform` snapshots, same account, before/after |
| anything else | `platform usage: unknown` |

## Storage

Snapshots live in the `usage_snapshots` table alongside the ledger. The quantity
column is named `quantities` (not `values`, which is a reserved SQL word). The
snapshot id is a content hash of label + observation time + class + quantities,
so re-recording the same observation is idempotent.

## Tests

`packages/usage/tests/usage.test.ts` (15 tests) covers provenance capture,
class rejection, precision preservation, range handling, refusal of derived
request counts, cross-class diff refusal, and the measured/ledger/proxy
isolation rule.
