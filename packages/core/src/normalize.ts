import { DEFAULT_FRESHNESS, FRESHNESS, type Freshness, type GrokMaxTask } from "./types.js";

/**
 * Normalize a task into a canonical form suitable for hashing.
 *
 * L2 normalized intent cache should strip representation noise (whitespace,
 * formatting, redundancy) while ALWAYS preserving constraints and every
 * meaning-affecting field.
 */
export interface NormalizedTask extends GrokMaxTask {
  intent: string;
  goal: string;
  constraints: string[];
  contextRefs: string[];
  freshness: Freshness;
  _canonical: {
    normalizedIntent: string;
    normalizedGoal: string;
    normalizedConstraints: string[];
    sortedContextRefs: string[];
    key: string;
  };
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeTask(task: GrokMaxTask): NormalizedTask {
  const intent = normalizeWhitespace(task.intent ?? "");
  const goal = normalizeWhitespace(task.goal ?? "");

  const constraints = dedupe(
    (task.constraints ?? []).map(normalizeWhitespace).filter((c) => c.length > 0)
  );

  const contextRefs = dedupe((task.contextRefs ?? []).map((c) => c.trim()).filter((c) => c.length > 0));

  const freshness: Freshness = normalizeFreshness(task.freshness);

  const normalized: NormalizedTask = {
    ...task,
    intent,
    goal,
    constraints,
    contextRefs,
    freshness,
    _canonical: {
      normalizedIntent: intent,
      normalizedGoal: goal,
      normalizedConstraints: constraints,
      sortedContextRefs: [...contextRefs].sort(),
      key: ""
    }
  };
  normalized._canonical.key = describeKey(normalized);
  return normalized;
}

export function normalizeFreshness(f: unknown): Freshness {
  if (typeof f === "string" && f in FRESHNESS) {
    return f as Freshness;
  }
  return DEFAULT_FRESHNESS;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * A canonical key that captures every meaning-affecting dimension of the task.
 * Constraints and freshness are part of the key so a cache entry for
 * `pnpm only` is never returned for a task that says `npm only`.
 */
export function describeKey(task: NormalizedTask): string {
  const constraints = task.constraints.length > 0 ? `|C:${task.constraints.join(" ~ ")}` : "";
  const refs = task._canonical.sortedContextRefs.length > 0 ? `|R:${task._canonical.sortedContextRefs.join(" ~ ")}` : "";
  return [
    `I:${task._canonical.normalizedIntent}`,
    `G:${task._canonical.normalizedGoal}`,
    `F:${task.freshness}`,
    `O:${task.output ?? "answer"}`,
    `E:${task.preferredExecutor ?? "auto"}`
  ]
    .join(" | ")
    .concat(constraints, refs);
}

export function canonicalInput(task: GrokMaxTask): string {
  return JSON.stringify(normalizeTask(task), null, 0);
}

/**
 * Normalized-hash: ignores representation noise but includes constraints.
 */
export function normalizedKey(task: NormalizedTask): string {
  return [
    "NK",
    task._canonical.normalizedIntent.toLowerCase(),
    task._canonical.normalizedGoal.toLowerCase(),
    [...task.constraints].map((c) => c.toLowerCase()).sort().join("~"),
    task.freshness,
    task.output ?? "answer",
    task.preferredExecutor ?? "auto"
  ].join("::");
}