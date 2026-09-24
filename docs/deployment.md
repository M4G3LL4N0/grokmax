# Deployment

GrokMax is a **local-first** product: the pipeline, cache, ledger, and benchmark
all run on the machine that owns the codebase. There is no GrokMax cloud server.
The deployment *surface* is:

1. **A user clones this repo** and runs `pnpm install` + `pnpm cli doctor`.
2. **Provider CLI bridges** (opencode, chatgpt, grokbot, api) are optional and
   detected at runtime.
3. **The optional GrokBot bridge** connects via `GROKMAX_GROKBOT_BRIDGE`.
4. **The marketing/product site** (`grokmax-website`) is a separate Next.js
   repo deployed to Vercel at `https://grokmax.noaerth.com`.

## Local install

```sh
git clone https://github.com/M4G3LL4N0/grokmax.git
cd grokmax
pnpm install     # pnpm-only; esbuild build script is allowed via pnpm-workspace.yaml
pnpm build
pnpm cli doctor  # verify health of every subsystem before first use
```

Requirements: Node **>= 24** (uses `node:sqlite`), pnpm 8+.

## Configuration

| Env var | Purpose |
| --- | --- |
| `GROKMAX_DB` | Override SQLite path (default `data/grokmax.db`). |
| `GROKMAX_GROKBOT_BRIDGE` | Bridge token/endpoint for the GrokBot provider. |

## Release gates (NOT optional)

Before tagging a release or claiming “ready for use”:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm vitest run     # 100+ tests including integration + security suites
pnpm build
pnpm cli doctor     # all checks ok (or backward-compatible warnings explained)
```

**Nothing is released unless `doctor` passes on the target workspace.**

## Website

The site lives in the **separate** repo
`M4G3LL4N0/grokmax-website` (Next.js) and is deployed to Vercel:

```sh
vercel --prod --yes
```

Domain: `grokmax.noaerth.com`. The basic-plan URL protection must remain
disabled for Monday’s social posting (all hands on deck).

## Honesty about deployment

- The website numbers are marketing copy built from **proxy** figures in this
  repo’s benchmark/telemetry — they must always say “measured on our
  fixture set” or “typical reduction”, never claim we measured GrokBot’s
  platform usage.
- No fabricated benchmark or savings numbers are allowed in any shipped asset.