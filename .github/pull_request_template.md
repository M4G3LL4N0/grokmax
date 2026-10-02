## What this changes

<!-- One or two sentences. What is different after this PR? -->

## Why

<!-- The problem this solves, or the claim it establishes. -->

## Verification

<!-- Paste the actual command and its real output. -->

```
$ pnpm run lint
$ pnpm run typecheck
$ pnpm run build
$ pnpm run test
```

## Honesty check

GrokMax is held to a specific standard: **no component reports a number it did
not measure.**

- [ ] Every new number is labelled `measured`, `estimated`, or `proxy`
- [ ] No savings figure is presented as billed cost without live measurement
- [ ] New routing precedence is documented in the README table
- [ ] Tests cover the new path, including the degradation path
- [ ] `pnpm run doctor` still reports the routing table honestly
