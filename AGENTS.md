# grokmax

## Purpose

GrokMax is a deterministic-first execution pipeline for GrokBot: it routes every task to the cheapest capable executor, slims the context to what matters, and caches the result across five layers so nothing is paid for twice. <!-- confidence:HIGH src:readme-description -->

## Stack

vitest

**Package manager** `pnpm`

## Layout

- _entrypoints and important paths_

## Do not edit

- `node_modules/`, `dist/`, `.next/`, `build/`, `coverage/`

<!-- Managed by TrillionX Agent Fabric. Edit outside the markers; re-run `agent-fabric apply` after editing inside them. -->
<!-- TRILLIONX:AGENTS:BEGIN -->
## Commands & verification (cheapest first)
setup: `pnpm install`
| # | Check | Command |
|---|-------|---------|
| 0 | inspect-diff | `git diff` |
| 1 | format-check | `pnpm run lint` |
| 2 | typecheck | `pnpm run typecheck` |
| 4 | build | `pnpm run build` |
| 5 | full-test-suite | `pnpm run test` |
Use the cheapest level covering the blast radius. Never claim done unverified; if a level cannot run, say so.

## Agent roles
Delegate, don't role-play: `worker` implements, `reviewer` is read-only review, `escalator` is read-only root-cause diagnosis. Definitions and model routing: `.cursor/agents/`.

## Context discipline
Search before reading; read the smallest useful range. Inspect changes with `git diff`, never re-reading unchanged files.
Skip `node_modules`, `dist`, `.next`, `build`, `coverage`, `vendor`. Filter logs (`rg`, `grep`, `tail`, a scoped test reporter) instead of dumping them.
Prefer a deterministic script over having a model rediscover a command. Delegate to the cheapest capable role. Stop when acceptance criteria pass.
<!-- TRILLIONX:AGENTS:END -->
