# Security

GrokMax runs locally, touches your filesystem and git, and talks to provider
CLIs. Security here matters.

## Threat model (what we defend against)

1. **Secrets leaking into logs or context.** Prompt output must never include
   tokens, keys, or passwords (masked).
2. **Prompt injections propagating as constraints.** Text that says “ignore
   previous instructions” or “do the opposite” must be treated as *context*,
   never as an executable constraint. Hard constraints come from the task, not
   from untrusted snippets.
3. **Artifact cross-scope reads.** An artifact written in one scope must not be
   readable from another. `ArtifactStore.get` is scope-checked; the engine only
   reuses known artifact refs, so a crafted `contextRefs` value cannot exfiltrate
   a foreign-scope artifact.
4. **Path traversal in refs.** `computeDependencyFingerprint` resolves refs
   inside cwd only; refs that escape cwd are ignored.
5. **Hostile determinism.** The safe-arithmetic evaluator is a hand-written
   recursive-descent parser (`no eval`). Unbalanced, over-precise, or
   divide-by-zero input returns `null` instead of crashing.
6. **Misreporting.** Savings are honesty-labeled (measured / estimated /
   proxy). A security issue is also an integrity issue.

## Verifiable guarantees

- `validatePreservation` fails loudly if a hard constraint token is lost during
  compression.
- The router treats a refused GrokBot budget as `none`, not as a silent
  workaround.
- The doctor scans `.env`/`.env.local` and flags likely secrets so they are not
  committed.

## Reporting

If you believe you have found a vulnerability in GrokMax, **do not open a public
issue**. Report privately by opening a GitHub issue with the label `security`
or contacting the maintainers at the repository’s issue tracker.

We receive no bounty budget yet — this is an internal product in a venture
portfolio — but we take every report seriously and will acknowledge promptly.