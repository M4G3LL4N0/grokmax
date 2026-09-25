/**
 * In-Bot Mode.
 *
 * GrokBot asks GrokMax one question before it spends anything: "is there
 * already a good answer, should another worker do this, or do you genuinely
 * need me?" The answer is a small, stable, machine-readable contract so the
 * GrokBot skill stays tiny and cannot drift into redoing work.
 *
 * Actions:
 *   RETURN_EXISTING_RESULT - a valid cached/artifact result already answers this.
 *   DELEGATE              - another worker (OpenCode/ChatGPT/deterministic/API) can do it.
 *   GROKBOT_REQUIRED      - the task needs authenticated browser / persistent-computer work.
 *   FAIL                  - no route can complete this; do not spend on a guess.
 *
 * The contract is deliberately small. GrokBot is told exactly what to do with
 * each action in `instruction`, so the skill does not need to embed policy.
 */
import type { CacheLookup, GrokMaxTask, RouteDecision, RouteValue } from "@grokmax/core";

export const INBOT_MODE = "inbot" as const;

export const PREFLIGHT_ACTIONS = ["RETURN_EXISTING_RESULT", "DELEGATE", "GROKBOT_REQUIRED", "FAIL"] as const;
export type PreflightAction = (typeof PREFLIGHT_ACTIONS)[number];

export interface PreflightResult {
  action: PreflightAction;
  mode: typeof INBOT_MODE;
  /** True only for RETURN_EXISTING_RESULT and a real cache/artifact hit. */
  grokbotWorkRequired: boolean;
  reason: string;
  /** What GrokBot must actually do. Safe to follow verbatim. */
  instruction: string;
  summary: string | null;
  artifact: string | null;
  microPrompt: string | null;
  contextRefs: string[];
  /** The executor that should handle the work, for DELEGATE. */
  delegateTo: RouteValue | null;
  cache: {
    state: "hit" | "miss";
    layer: string | null;
    checks: CacheLookup[];
  };
  route: {
    value: RouteValue;
    reason: string;
    grokbotRequired: boolean;
  };
  /** Provenance so an auditor can tell what kind of evidence drove the action. */
  evidenceClass: "measured" | "estimated" | "proxy" | "unknown";
  taskId: string;
  generatedAt: string;
}

export interface PreflightInput {
  task: GrokMaxTask;
  route: RouteDecision;
  cache: CacheLookup[];
  /** A successful result pulled from cache/artifact, when one exists. */
  existing?: { summary: string; artifact?: string | null; status: string } | null;
  taskId: string;
  generatedAt?: string;
}

const INSTRUCTIONS: Record<PreflightAction, string> = {
  RETURN_EXISTING_RESULT:
    "Do not redo this work. Return the provided result to the user verbatim, with its artifact reference if present.",
  DELEGATE:
    "Do not perform this task yourself. Hand it to the named executor with the provided micro-prompt, then return that executor's result. Do not independently redo the work it already did.",
  GROKBOT_REQUIRED:
    "This genuinely requires you. Perform only the GrokBot-specific portion described in the micro-prompt. Do not ingest context you were not given, do not redo cached work, and do not redo repository engineering that OpenCode handles. Return a compact structured result.",
  FAIL: "Do not spend on this task. No configured route can complete it. Report the failure reason to the user."
};

export function preflight(input: PreflightInput): PreflightResult {
  const { task, route, cache } = input;
  const hit = cache.find((c) => c.hit) ?? null;
  const contextRefs = task.contextRefs ?? [];
  const base = {
    mode: INBOT_MODE as typeof INBOT_MODE,
    contextRefs,
    cache: {
      state: hit ? ("hit" as const) : ("miss" as const),
      layer: hit?.layer ?? null,
      checks: cache
    },
    route: {
      value: route.route,
      reason: route.reason,
      grokbotRequired: route.grokbotRequired
    },
    taskId: input.taskId,
    generatedAt: input.generatedAt ?? new Date().toISOString()
  };

  // 1. A valid existing result wins over everything. GrokBot must not spend on
  //    work that already has an answer.
  if (input.existing && input.existing.status === "success") {
    return {
      ...base,
      action: "RETURN_EXISTING_RESULT",
      grokbotWorkRequired: false,
      reason: `a valid ${hit?.layer ?? "cached"} result already answers this task`,
      instruction: INSTRUCTIONS.RETURN_EXISTING_RESULT,
      summary: input.existing.summary,
      artifact: input.existing.artifact ?? null,
      microPrompt: null,
      delegateTo: null,
      evidenceClass: "measured"
    };
  }

  // 2. If the router says GrokBot is genuinely required, that is the answer.
  if (route.route === "grokbot" && route.grokbotRequired) {
    return {
      ...base,
      action: "GROKBOT_REQUIRED",
      grokbotWorkRequired: true,
      reason: route.reason,
      instruction: INSTRUCTIONS.GROKBOT_REQUIRED,
      summary: null,
      artifact: null,
      microPrompt: buildMicroPrompt(task),
      delegateTo: null,
      evidenceClass: "estimated"
    };
  }

  // 3. A cheaper capable worker should do it.
  if (route.route !== "none" && route.route !== "grokbot") {
    return {
      ...base,
      action: "DELEGATE",
      grokbotWorkRequired: false,
      reason: `router selected ${route.route}: ${route.reason}`,
      instruction: INSTRUCTIONS.DELEGATE,
      summary: null,
      artifact: null,
      microPrompt: buildMicroPrompt(task),
      delegateTo: route.route,
      evidenceClass: "estimated"
    };
  }

  // 4. Nothing can run this.
  return {
    ...base,
    action: "FAIL",
    grokbotWorkRequired: false,
    reason: route.reason || "no capable route available",
    instruction: INSTRUCTIONS.FAIL,
    summary: null,
    artifact: null,
    microPrompt: null,
    delegateTo: null,
    evidenceClass: "unknown"
  };
}

/**
 * The micro-prompt is the entire context GrokBot is handed. It is intentionally
 * compact: the point of In-Bot mode is that GrokBot does not re-ingest the
 * whole repository or re-derive context GrokMax already minimized.
 */
export function buildMicroPrompt(task: GrokMaxTask): string {
  const parts: string[] = [`GOAL: ${task.goal}`];
  if (task.intent && task.intent !== task.goal) parts.push(`INTENT: ${task.intent}`);
  if (task.constraints && task.constraints.length > 0) {
    parts.push(`CONSTRAINTS (must hold exactly):`);
    for (const c of task.constraints) parts.push(`  - ${c}`);
  }
  if (task.contextRefs && task.contextRefs.length > 0) {
    parts.push(`CONTEXT REFS: ${task.contextRefs.join(", ")}`);
  }
  parts.push("SCOPE: perform only the GrokBot-specific portion. Do not redo cached or repository work.");
  return parts.join("\n");
}

export function formatPreflight(r: PreflightResult): string {
  const lines: string[] = [];
  lines.push(`ACTION     ${r.action}`);
  lines.push(`MODE       ${r.mode}`);
  lines.push(`REASON     ${r.reason}`);
  lines.push(`GROKBOT WORK REQUIRED  ${r.grokbotWorkRequired ? "yes" : "no"}`);
  lines.push(`CACHE      ${r.cache.state}${r.cache.layer ? ` via ${r.cache.layer}` : ""}`);
  lines.push(`ROUTE      ${r.route.value}`);
  if (r.delegateTo) lines.push(`DELEGATE TO ${r.delegateTo}`);
  lines.push("INSTRUCTION");
  lines.push(`  ${r.instruction}`);
  if (r.summary) lines.push(`SUMMARY    ${r.summary}`);
  if (r.artifact) lines.push(`ARTIFACT   ${r.artifact}`);
  if (r.microPrompt) {
    lines.push("MICRO-PROMPT");
    for (const line of r.microPrompt.split("\n")) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

/**
 * Verify that a recorded GrokBot result really came from an In-Bot preflight.
 * A GrokBot invocation is only attributable to In-Bot mode when the preflight
 * asked for it, so this pairing is checkable after the fact.
 */
export interface InbotInvocationProof {
  preflightTaskId: string;
  preflightAction: PreflightAction;
  preflightGeneratedAt: string;
  preflightSaidGrokbotRequired: boolean;
  grokbotRunId: string;
}

export function verifyInbotInvocation(proof: InbotInvocationProof): { verified: boolean; reason: string } {
  if (proof.preflightAction !== "GROKBOT_REQUIRED") {
    return { verified: false, reason: `preflight returned ${proof.preflightAction}, so the GrokBot call was not an In-Bot sanctioned invocation` };
  }
  if (!proof.preflightSaidGrokbotRequired) {
    return { verified: false, reason: "preflight did not mark GrokBot work as required" };
  }
  return { verified: true, reason: `GrokBot run ${proof.grokbotRunId} followed a GROKBOT_REQUIRED preflight (task ${proof.preflightTaskId})` };
}
