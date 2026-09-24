# GrokMax Launch Checklist

Sunday night checklist for the Monday social launch of GrokMax.

## Product readiness

- [x] Monorepo builds: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm build` all green
- [x] Tests green: 151 tests across 18 files incl. integration + security suites
- [x] Deterministic resolver: 33 fixtures / 5 suites at 100% match (measured locally; 5 escape fixtures are expected declines)
- [x] `grokmax doctor` passes health checks on the workspace
- [x] Zero-model-cost routing proven: math/hash/file-count/git never touch GrokBot
- [x] Honest telemetry: savings labeled measured / estimated / proxy, never mixed in one denominator

## Repo cleanliness

- [x] Remove absolute user path `/Users/matador/startups/grokmax` from committed fixtures (verified: only appears in this checklist)
- [x] Confirm `git status` clean, no secrets, no `/tmp` refs in tests
- [ ] Initial commit + tag `v0.1.0` (branches first)

## Website (grokmax-website, separate repo)

- [x] Next.js repo scaffolded
- [x] OG/social assets wired (assets/grokmax-og.png 1200x630, social card 1080x1080)
- [x] Vercel deploy to https://grokmax.noaerth.com: production READY, domain attached + verified
- [x] Check title/meta/OG on live URL
- [ ] DNS record at Namecheap (A grokmax.noaerth.com -> 76.76.21.21) so the custom domain actually resolves — vercel.app URLs stay behind Vercel's Hobby login wall until then
- [ ] Confirm https://grokmax.noaerth.com serves the site publicly once DNS propagates
- [ ] Check title/meta/OG on the public URL

## Social assets

- [x] OG image (1200x630) at assets/grokmax-og.png
- [x] Social card (1080x1080) at assets/grokmax-social-card.png
- [x] Hook line: "Scale down before you scale up."

## Honesty gate (non-negotiable)

- [x] No fabricated benchmark or savings numbers, anywhere
- [x] Every claim on the site says what was actually measured (local fixture runs) vs estimated/proxy
- [x] No claim that we measure GrokBot's platform usage (we don't)
- [x] Independence disclaimer published: GrokMax is not affiliated with Cursor or xAI

## Verification

- [x] Final gate run: install/lint/typecheck/test/build all green at v0.1.1
- [x] `pnpm run doctor`: 15 healthy, 3 warning, 0 failure (warnings are environmental)
- [x] `pnpm benchmark`: 33 fixtures, 100% match, 0 GrokBot required
- [ ] Live smoke: `pnpm cli optimize` miss then hit, `pnpm cli savings --json`