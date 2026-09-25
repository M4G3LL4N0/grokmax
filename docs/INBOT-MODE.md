# In-Bot Mode

In-Bot Mode is how GrokBot asks GrokMax "should I be doing this at all?" *before*
it spends anything. The skill is deliberately tiny: it makes one call and
follows the returned instruction.

## The contract

```bash
grokmax preflight "<task>" --json
```

```bash
node skills/grokmax/inbot.mjs "<task>" --explain
```

Exactly one of four actions comes back:

| Action | `grokbotWorkRequired` | Meaning |
| --- | --- | --- |
| `RETURN_EXISTING_RESULT` | `false` | a valid cached/artifact result already answers this |
| `DELEGATE` | `false` | another executor (`delegateTo`) should do it |
| `GROKBOT_REQUIRED` | `true` | genuinely needs authenticated browser / persistent-computer work |
| `FAIL` | `false` | no configured route can complete it; do not spend |

### Precedence

1. **A valid existing result always wins** — even over a router decision that
   would have used GrokBot. There is no point spending on work already done.
2. Otherwise, if the router says GrokBot is required, that is the answer.
3. Otherwise, if a cheaper capable worker exists, delegate to it.
4. Otherwise, fail rather than guess.

A cached *failure* is not treated as an existing result. Reusing it would tell
the caller "already done" about work that never actually succeeded.

## Output shape

```json
{
  "action": "DELEGATE",
  "mode": "inbot",
  "grokbotWorkRequired": false,
  "reason": "router selected opencode: repository modification/inspection required",
  "instruction": "Do not perform this task yourself. Hand it to the named executor ...",
  "summary": null,
  "artifact": null,
  "microPrompt": "GOAL: Refactor the parser module\n...",
  "contextRefs": ["README.md"],
  "delegateTo": "opencode",
  "cache": { "state": "miss", "layer": null, "checks": [] },
  "route": { "value": "opencode", "reason": "...", "grokbotRequired": false },
  "evidenceClass": "estimated",
  "taskId": "...",
  "generatedAt": "2026-09-24T..."
}
```

Every field is always present, so the contract is safe to consume
programmatically. `evidenceClass` records what kind of evidence drove the
decision: `measured` for a real cached result, `estimated` for a router
decision, `unknown` for a failure.

## The micro-prompt

When GrokBot is genuinely required, it receives a compact, bounded prompt:

```
GOAL: Submit the retirement form
CONSTRAINTS (must hold exactly):
  - do not exceed 250 USD
  - use account 4471
CONTEXT REFS: forms/retirement.pdf
SCOPE: perform only the GrokBot-specific portion. Do not redo cached or repository work.
```

Constraints appear **verbatim**, including negations. The point is that GrokBot
does not re-ingest the repository or re-derive context GrokMax already
minimized.

## The skill

`skills/grokmax/SKILL.md` is the whole skill. Its rules:

1. Preflight first, always. One call, at the start.
2. Never redo work a `RETURN_EXISTING_RESULT` covers.
3. Never redo work a `DELEGATE` assigned to another worker.
4. Never ingest context you were not handed.
5. Stay inside the scope `GROKBOT_REQUIRED` gave you.
6. Return a compact structured result so GrokMax can persist it.

`skills/grokmax/inbot.mjs` is a runnable wrapper so the skill is executable
rather than descriptive. It shells out to the real CLI, validates that the
returned action is one of the four known values, and exits non-zero on `FAIL`.

## Verifying an In-Bot invocation

A GrokBot invocation only counts as In-Bot mode when the recorded preflight
returned `GROKBOT_REQUIRED` for the same task. `verifyInbotInvocation()` in
`packages/inbot/src/index.ts` checks exactly that pairing, and is what prevents
"we invoked GrokBot" from being presented as "In-Bot mode works".

## Tests

`packages/inbot/tests/inbot.test.ts` (18 tests) covers all four actions,
cache-return precedence, failed-result rejection, micro-prompt constraint
fidelity, JSON round-tripping, and invocation verification.
