# GrokMax Launch Checklist

Sunday night checklist for the Monday social launch of GrokMax.

## Product readiness

- [x] Monorepo builds: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm build` all green
- [x] Tests green: 109 tests across 12 files incl. integration + security suites
- [x] Deterministic resolver: 33 fixtures / 5 suites at 100% resolve + 100% outcome (measured locally)
- [x] `grokmax doctor` passes health checks on the workspace
- [x] Zero-cost routing proven: math/hash/file-count/git never touch GrokBot
- [x] Honest telemetry: savings labeled measured / estimated / proxy

## Repo cleanliness

- [x] Remove absolute user path `/Users/matador/startups/grokmax` from committed fixtures (verified: only appears in this checklist)
- [ ] Confirm `git status` clean, no secrets, no `/tmp` refs in tests
- [ ] Initial commit + tag `v0.1.0` (branches first)

## Website (grokmax-website, separate repo)

- [ ] Next.js repo scaffolded
- [ ] OG/social assets wired (assets/grokmax-og.png 1200x630, social card 1080x1080)
- [ ] Vercel deploy to https://grokmax.noaerth.com (basic-plan protection DISABLED so the link is shared publicly)
- [ ] Check title/meta/OG on live URL

## Social assets

- [x] OG image (1200x630) at assets/grokmax-og.png
- [x] Social card (1080x1080) at assets/grokmax-social-card.png
- [x] Hook line: "Scale down before you scale up."

## Honesty gate (non-negotiable)

- [ ] No fabricated benchmark or savings numbers, anywhere
- [ ] Every claim on the site says what was actually measured (local fixture runs) vs estimated/proxy
- [ ] No claim that we measure GrokBot's platform usage (we don't)

## Verification

- [ ] Final gate run on clean clone: install/lint/typecheck/test/build/doctor
- [ ] Live smoke: `pnpm cli optimize` miss then hit, `pnpm cli benchmark`, `pnpm cli savings --json`