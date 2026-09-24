/**
 * Context slicer.
 *
 * Goal: send 1,500 relevant tokens instead of 20,000. Selection is driven by
 * task intent, referenced files/artifacts, durable project rules, dependencies,
 * recency, and explicit user requirements. Every exclusion is explained and
 * measured (before/after bytes + token estimates).
 */
import type { ContextSlice, ContextUnit, GrokMaxTask } from "@grokmax/core";
import { estimateTokens } from "@grokmax/core";

const STOP = new Set([
  "the", "and", "for", "you", "your", "this", "that", "with", "from", "into", "about",
  "where", "when", "what", "have", "been", "will", "not", "are", "was", "were", "does",
  "please", "need", "want", "should", "would", "could", "can", "give", "make", "using"
]);

export function significantTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t))
    )
  ];
}

export interface SlicerOptions {
  maxContextChars?: number;
  minKeep?: number;
}

function refMatches(ref: string, unitId: string): boolean {
  const a = ref.trim();
  const b = unitId.trim();
  if (a === b) return true;
  if (a.startsWith("grokmax://")) return false;
  const baseA = a.split("/").pop();
  const baseB = b.split("/").pop();
  return Boolean(baseA && baseB && baseA === baseB);
}

export async function sliceTaskContext(
  task: GrokMaxTask,
  units: ContextUnit[],
  opts: SlicerOptions = {}
): Promise<ContextSlice> {
  const maxChars = opts.maxContextChars ?? 6000;
  const minKeep = opts.minKeep ?? 1;
  const taskTokens = significantTokens(`${task.intent}\n${task.goal}\n${(task.constraints ?? []).join(" ")}`);
  const taskRefs = new Set(task.contextRefs ?? []);
  const constraintPhrase = (task.constraints ?? []).join(" ").toLowerCase();

  const beforeBytes = units.reduce((acc, u) => acc + u.bytes, 0);
  const beforeChars = units.reduce((acc, u) => acc + u.content.length, 0);

  const required = new Set<string>();
  for (const u of units) {
    const referenced = [...taskRefs].some((r) => refMatches(r, u.id));
    const isDurableRule = u.kind === "rule";
    if (referenced || isDurableRule) required.add(u.id);
  }

  type Scored = { unit: ContextUnit; score: number; reason: string };
  const scored: Scored[] = units.map((unit) => {
    const unitTokens = significantTokens(unit.content);
    const overlap = jaccard(unitTokens, taskTokens);
    let score = overlap;
    const reasons: string[] = [];

    if (required.has(unit.id)) {
      score += 2;
      reasons.push("referenced / durable rule");
    }
    if (unit.kind === "history") {
      score *= 1.0; // recency handled later
      reasons.push("history");
    }
    if (unit.kind === "dependency") {
      score += 0.5;
      reasons.push("dependency");
    }
    if (constraintPhrase && unit.content.toLowerCase().includes(constraintPhrase.slice(0, 30))) {
      score += 0.8;
      reasons.push("constraint match");
    }
    score -= Math.min(0.4, unit.content.length / 200000);
    if (reasons.length === 0) reasons.push(`overlap ${overlap.toFixed(3)}`);
    return { unit, score, reason: reasons.join(", ") };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: ContextUnit[] = [];
  const excluded: ContextUnit[] = [];
  const excludedReasons: Record<string, string> = {};
  let budget = maxChars;

  for (const s of scored) {
    const isRequired = required.has(s.unit.id);
    const fits = s.unit.content.length <= budget;
    if (isRequired || (s.score >= 0.06 && fits) || selected.length < minKeep) {
      if (isRequired && !fits) {
        excludedReasons[s.unit.id] = `required but exceeds remaining budget (${s.unit.content.length} chars vs ${budget} left)`;
        excluded.push(s.unit);
        continue;
      }
      selected.push(s.unit);
      budget -= s.unit.content.length;
    } else {
      excluded.push(s.unit);
      excludedReasons[s.unit.id] = s.score < 0.06 ? `relevance score ${s.score.toFixed(3)} below threshold` : `budget exhausted (${budget} chars left)`;
    }
  }

  const afterBytes = selected.reduce((acc, u) => acc + u.bytes, 0);
  const afterChars = selected.reduce((acc, u) => acc + u.content.length, 0);

  return makeSlice(selected, excluded, beforeBytes, beforeChars, afterBytes, afterChars, excludedReasons);
}

function makeSlice(
  selected: ContextUnit[],
  excluded: ContextUnit[],
  beforeBytes: number,
  beforeChars: number,
  afterBytes: number,
  afterChars: number,
  excludedReasons: Record<string, string>
): ContextSlice {
  return {
    selected: selected.map((u) => ({ ...u })),
    excluded: excluded.map((u) => ({ ...u })),
    context_before_bytes: beforeBytes,
    context_after_bytes: afterBytes,
    contextBeforeChars: beforeChars,
    contextAfterChars: afterChars,
    tokenEstimateBefore: estimateTokens(beforeChars),
    tokenEstimateAfter: estimateTokens(afterChars),
    excludedReasons
  };
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}