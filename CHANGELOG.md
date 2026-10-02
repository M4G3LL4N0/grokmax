# Changelog

All notable changes to GrokMax are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0-rc.2] — 2026-10-02

> **Pre-release. This project's own adversarial audit marks this release
> NOT READY.** The audit is committed at `docs/GROKBOT-VERIFICATION.md` and
> is not summarised away here. Publishing it as a labelled pre-release is more
> useful than pretending the verdict does not exist.

### Added

- **Edge Mode and In-Bot Mode** — execution modes for constrained environments.
- **Platform measurement harness** — live experiment harness replacing
  estimated-only numbers.
- **CI gate** — lint, typecheck, build and test on Node 24. This was the only
  public project in the portfolio with a fully green local pipeline and no CI
  on GitHub.
- **Issue forms** — the bug form asks which confidence labels appeared on the
  numbers, because "it is wrong" is unactionable when the point of the ledger
  is `measured` / `estimated` / `proxy`.
- **PR template** — carries the honesty checklist.

### Fixed

- **Fail closed on order-inverted procedures.** A procedure whose steps run out
  of order now refuses rather than reporting success (L3 semantic safety).
- Bare-operator L3 cache hits that could return an unsafe result.
- Removed the dead `pnpm` field from `package.json`; pnpm 12 no longer reads it.

### Verification status

- `pnpm run lint`, `pnpm run typecheck`, `pnpm run build` — exit 0
- `pnpm run test` — 26 files, 287 tests passed, 0 failed
- Adversarial audit: `READY TO PUBLISH? = NO`
- Historical CRITICAL findings F1/F2 at `fd9c017` retained in the audit
- Gate B 21/22 retained, including bare-operator `FAIL_UNSAFE_HIT`

### Known limitations

Live account-savings claims, Edge Mode, and absolute-cost marketing are **not
cleared** by the audit. Token-reduction figures are proxies and are labelled as
such in the ledger.

## [0.1.1] — 2026-09-28

- Fixed the semantic-cache literal gate, added a `--fresh` bypass, corrected
  exit codes and routing order, tightened savings honesty, and contained path
  handling.

## [0.1.0] — 2026-09-25

- First deterministic-first task execution pipeline.

[Unreleased]: https://github.com/M4G3LL4N0/grokmax/compare/v0.2.0-rc.2...HEAD
[0.2.0-rc.2]: https://github.com/M4G3LL4N0/grokmax/releases/tag/v0.2.0-rc.2
[0.1.1]: https://github.com/M4G3LL4N0/grokmax/releases/tag/v0.1.1
[0.1.0]: https://github.com/M4G3LL4N0/grokmax/releases/tag/v0.1.0
