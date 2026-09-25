/**
 * Edge Mode.
 *
 * Edge Mode is not a separate pipeline. It is the real GrokMax pipeline, run
 * with one hard guarantee: the work must be completed, and GrokBot is only
 * allowed to be touched if the router says no other executor can do the job.
 *
 * The point of the mode is to produce a truthful, checkable statement:
 *
 *   "this task completed without invoking GrokBot"
 *
 * That statement is only allowed when every one of these is true:
 *   - the worker reported success;
 *   - the outcome met the requested task contract (criteria);
 *   - GrokBot was not invoked;
 *   - raw evidence is retained.
 *
 * A failed run is not an avoidance and is never counted as one. A run that
 * merely *could* have been done elsewhere is not an avoidance either.
 */
import type { CacheLookup, GrokMaxTask, RunOutcome } from "@grokmax/core";

export const EDGE_MODE = "edge" as const;

export type MeasurementClassification = "measured" | "estimated" | "proxy" | "unknown";

export interface EdgeCriteria {
  /** The worker result status must count as successful. */
  completed: boolean;
  /** If present, the outcome summary must match this pattern. */
  summaryRegex?: string;
  /** If present, a required substring of the outcome summary. */
  summaryContains?: string;
  /** If present, the number of evidence items must be at least this. */
  minEvidence?: number;
  /** If true, an artifact reference must have been produced. */
  requireArtifact?: boolean;
}

export const DEFAULT_EDGE_CRITERIA: EdgeCriteria = { completed: true };

export interface EdgeMeasurement {
  contextReduction: MeasurementClassification;
  externalCost: MeasurementClassification;
  platformUsage: MeasurementClassification;
  note: string;
}

export interface EdgeResult {
  mode: typeof EDGE_MODE;
  taskId: string;
  goal: string;
  route: string;
  routeReason: string;
  cacheState: "hit" | "miss";
  cacheLayer: string | null;
  cacheChecks: CacheLookup[];
  executor: string;
  success: boolean;
  status: string;
  grokbotRequired: boolean;
  grokbotInvoked: boolean;
  /** True only when success AND criteria met AND GrokBot untouched. */
  countedAsAvoided: boolean;
  /** Why the task did or did not meet its contract. */
  criteria: EdgeCriteria;
  criteriaMet: boolean;
  criteriaReason: string;
  contextBefore: number | null;
  contextAfter: number | null;
  summary: string;
  evidence: string[];
  artifact: string | null;
  measurement: EdgeMeasurement;
  elapsedMs: number;
  retries: number;
  errors: string[];
  runId: string;
}

export interface EdgeRunInput {
  task: GrokMaxTask;
  run: RunOutcome;
  criteria?: Partial<EdgeCriteria>;
  /** Override GrokBot invocation detection; defaults to executor-based. */
  grokbotInvoked?: boolean;
  taskId?: string;
}

export function evaluateEdge(outcome: RunOutcome, criteria: EdgeCriteria): { met: boolean; reason: string } {
  const worker = outcome.outcome;
  if (criteria.completed && !isSuccessful(worker.status)) {
    return { met: false, reason: `task did not complete: status=${worker.status}` };
  }
  if (criteria.summaryContains && !worker.summary.includes(criteria.summaryContains)) {
    return { met: false, reason: `outcome summary did not contain ${JSON.stringify(criteria.summaryContains)}` };
  }
  if (criteria.summaryRegex) {
    let re: RegExp;
    try {
      re = new RegExp(criteria.summaryRegex);
    } catch {
      return { met: false, reason: `summaryRegex is not a valid regular expression: ${criteria.summaryRegex}` };
    }
    if (!re.test(worker.summary)) {
      return { met: false, reason: `outcome summary did not match ${criteria.summaryRegex}` };
    }
  }
  if (criteria.minEvidence != null && worker.evidence.length < criteria.minEvidence) {
    return { met: false, reason: `expected at least ${criteria.minEvidence} evidence item(s), got ${worker.evidence.length}` };
  }
  if (criteria.requireArtifact && !worker.artifact) {
    return { met: false, reason: "task required an artifact but none was produced" };
  }
  return { met: true, reason: "task completed and met the requested contract" };
}

/**
 * Build the Edge Mode result from a real pipeline outcome. This function is the
 * only place that decides whether a run counts as an avoidance, so the rule is
 * auditable in one place.
 */
export function buildEdgeResult(input: EdgeRunInput): EdgeResult {
  const criteria: EdgeCriteria = { ...DEFAULT_EDGE_CRITERIA, ...(input.criteria ?? {}) };
  const outcome = input.run;
  const worker = outcome.outcome;
  const success = isSuccessful(worker.status);
  const { met, reason } = evaluateEdge(outcome, criteria);

  const executor = worker.executor || (outcome.route.grokbotRequired ? "grokbot" : "none");
  const grokbotInvoked = input.grokbotInvoked ?? isGrokbotExecutor(executor);

  const hitLayer = outcome.cache.find((c) => c.hit) ?? null;
  const cacheState = hitLayer ? "hit" : "miss";

  // The single honest gate for counting an avoidance.
  const countedAsAvoided = success && met && !grokbotInvoked;

  return {
    mode: EDGE_MODE,
    taskId: input.taskId ?? outcome.run.runId,
    goal: input.task.goal,
    route: outcome.route.route,
    routeReason: outcome.route.reason,
    cacheState,
    cacheLayer: hitLayer?.layer ?? null,
    cacheChecks: outcome.cache,
    executor,
    success,
    status: worker.status,
    grokbotRequired: outcome.route.grokbotRequired,
    grokbotInvoked,
    countedAsAvoided,
    criteria,
    criteriaMet: met,
    criteriaReason: reason,
    contextBefore: outcome.context?.contextBeforeChars ?? null,
    contextAfter: outcome.context?.contextAfterChars ?? null,
    summary: worker.summary,
    evidence: worker.evidence,
    artifact: worker.artifact ?? null,
    measurement: {
      contextReduction: "proxy",
      externalCost: worker.costUsd == null ? "unknown" : "estimated",
      platformUsage: "unknown",
      note: "Context reduction is a character-count proxy. External cost is a provider estimate. GrokBot platform usage is never observable from here."
    },
    elapsedMs: outcome.run.elapsedMs,
    retries: outcome.run.retries,
    errors: outcome.run.errors,
    runId: outcome.run.runId
  };
}

export function isSuccessful(status: string): boolean {
  return status === "success" || status === "partial";
}

export function isGrokbotExecutor(executor: string): boolean {
  return executor.toLowerCase() === "grokbot";
}

export function formatEdgeResult(r: EdgeResult): string {
  const lines: string[] = [];
  lines.push(`MODE       ${r.mode.toUpperCase()}`);
  lines.push(`TASK       ${r.taskId}`);
  lines.push(`ROUTE      ${r.route.toUpperCase()}  (${r.routeReason})`);
  lines.push(`CACHE      ${r.cacheState}${r.cacheLayer ? ` via ${r.cacheLayer}` : ""}`);
  lines.push(`EXECUTOR   ${r.executor}`);
  lines.push(`STATUS     ${r.status}`);
  lines.push(`GROKBOT    required=${r.grokbotRequired} invoked=${r.grokbotInvoked}`);
  lines.push(`CONTRACT   ${r.criteriaMet ? "met" : "NOT met"} — ${r.criteriaReason}`);
  lines.push(`CONTEXT    ${r.contextBefore ?? "?"} -> ${r.contextAfter ?? "?"} chars (proxy)`);
  lines.push(`ELAPSED    ${r.elapsedMs}ms  retries=${r.retries}`);
  if (r.artifact) lines.push(`ARTIFACT   ${r.artifact}`);
  lines.push(`AVOIDED    ${r.countedAsAvoided ? "yes — completed, no GrokBot invocation, contract met" : "no — see contract/grokbot lines"}`);
  if (r.errors.length > 0) {
    lines.push("ERRORS");
    for (const e of r.errors) lines.push(`  - ${e}`);
  }
  lines.push("OUTCOME");
  lines.push(`  ${r.summary}`);
  if (r.evidence.length > 0) {
    lines.push("EVIDENCE");
    for (const e of r.evidence) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

/**
 * Aggregate several edge results into a public-safe sentence. The fraction is
 * only rendered when every task in the denominator genuinely counts; otherwise
 * the report refuses to produce a ratio and explains why.
 */
export function edgeAvoidanceSummary(results: EdgeResult[]): string {
  const eligible = results.length;
  const avoided = results.filter((r) => r.countedAsAvoided).length;
  if (eligible === 0) return "GrokMax avoided GrokBot on 0/0 eligible Edge tasks (no tasks run).";

  const failures = results.filter((r) => !r.success).length;
  const contractMisses = results.filter((r) => r.success && !r.criteriaMet).length;
  const invoked = results.filter((r) => r.grokbotInvoked).length;

  if (failures > 0 || contractMisses > 0 || invoked > 0) {
    const reasons: string[] = [];
    if (failures > 0) reasons.push(`${failures} task(s) did not complete`);
    if (contractMisses > 0) reasons.push(`${contractMisses} task(s) missed their contract`);
    if (invoked > 0) reasons.push(`${invoked} task(s) invoked GrokBot`);
    return `GrokMax avoided GrokBot on ${avoided}/${eligible} eligible Edge tasks (${reasons.join("; ")}). Failed work is not counted as savings.`;
  }

  return `GrokMax avoided GrokBot on ${avoided}/${eligible} eligible Edge tasks (all completed, contract met, no GrokBot invocation).`;
}
