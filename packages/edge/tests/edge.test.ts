import { describe, expect, it } from "vitest";
import { buildEdgeResult, edgeAvoidanceSummary, evaluateEdge, formatEdgeResult, isSuccessful, type EdgeResult } from "@grokmax/edge";
import { EXECUTION_STATUS, type CacheLookup, type CompiledPrompt, type ContextSlice, type GrokMaxTask, type LedgerEntry, type RouteDecision, type RunOutcome, type WorkerResult } from "@grokmax/core";

function route(over: Partial<RouteDecision> = {}): RouteDecision {
  return {
    route: "deterministic",
    reason: "deterministic-math resolvable locally with zero intelligence cost",
    grokbotRequired: false,
    cache: "miss",
    budget: { withinUsdBudget: true, estimatedUsd: 0, maxUsd: null, withinGrokBotBudget: true, grokbotUsageEstimate: 0, maxGrokBotUsage: null },
    checks: [],
    cheaperThanDirect: true,
    ...over
  };
}

function worker(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: EXECUTION_STATUS.SUCCESS,
    executor: "deterministic",
    summary: "50+1 = 51",
    evidence: ["evaluated locally"],
    grokbotRequired: false,
    costUsd: 0,
    ...over
  };
}

function context(): ContextSlice {
  return {
    selected: [],
    excluded: [],
    context_before_bytes: 2000,
    context_after_bytes: 800,
    contextBeforeChars: 2000,
    contextAfterChars: 800,
    tokenEstimateBefore: 500,
    tokenEstimateAfter: 200,
    excludedReasons: {}
  };
}

function outcome(over: { worker?: Partial<WorkerResult>; route?: Partial<RouteDecision>; cache?: CacheLookup[]; context?: ContextSlice | null } = {}): RunOutcome {
  const w = worker(over.worker);
  const r = route(over.route);
  const cache = over.cache ?? [{ layer: "L1", hit: false, reason: "no exact cache entry" }];
  const entry: LedgerEntry = {
    runId: "run-abc123",
    taskText: "Calculate 50+1",
    intent: "Calculate 50+1",
    goal: "Calculate 50+1",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    elapsedMs: 12,
    cache,
    route: r,
    context: over.context === undefined ? context() : over.context,
    compiled: null,
    worker: w,
    retries: 0,
    errors: [],
    humanIntervention: false,
    measured: {},
    status: w.status
  };
  const task: GrokMaxTask = { intent: "Calculate 50+1", goal: "Calculate 50+1" };
  return { task, cache, route: r, context: entry.context, compiled: null, worker: w, outcome: w, explain: "", run: entry };
}

describe("Edge Mode: completing work without GrokBot", () => {
  it("reports a zero-GrokBot completion for a task the deterministic resolver handles", () => {
    const res = buildEdgeResult({ task: outcome().task, run: outcome(), taskId: "edge-1" });
    expect(res.mode).toBe("edge");
    expect(res.taskId).toBe("edge-1");
    expect(res.route).toBe("deterministic");
    expect(res.executor).toBe("deterministic");
    expect(res.success).toBe(true);
    expect(res.grokbotRequired).toBe(false);
    expect(res.grokbotInvoked).toBe(false);
    expect(res.countedAsAvoided).toBe(true);
    expect(res.criteriaMet).toBe(true);
    expect(res.summary).toBe("50+1 = 51");
    expect(res.measurement.platformUsage).toBe("unknown");
    expect(res.measurement.contextReduction).toBe("proxy");
  });

  it("exposes context before/after, elapsed time and measurement classifications", () => {
    const res = buildEdgeResult({ task: outcome().task, run: outcome() });
    expect(res.contextBefore).toBe(2000);
    expect(res.contextAfter).toBe(800);
    expect(res.elapsedMs).toBe(12);
    expect(res.measurement.externalCost).toBe("estimated");
    expect(typeof res.measurement.note).toBe("string");
  });

  it("records a cache hit in the structured output", () => {
    const res = buildEdgeResult({
      task: outcome().task,
      run: outcome({ cache: [{ layer: "L1", hit: true, reason: "exact hit" }] }),
    });
    expect(res.cacheState).toBe("hit");
    expect(res.cacheLayer).toBe("L1");
  });
});

describe("Edge Mode: GrokBot is invoked only when genuinely required", () => {
  it("marks grokbotInvoked when the executor is grokbot and never counts it as avoided", () => {
    const res = buildEdgeResult({
      task: outcome().task,
      run: outcome({ worker: { executor: "grokbot", summary: "clicked through the portal", grokbotRequired: true }, route: { route: "grokbot", grokbotRequired: true, reason: "authenticated browser interaction required" } })
    });
    expect(res.grokbotRequired).toBe(true);
    expect(res.grokbotInvoked).toBe(true);
    expect(res.success).toBe(true);
    expect(res.countedAsAvoided).toBe(false);
  });

  it("honours an explicit grokbotInvoked override from the bridge", () => {
    const res = buildEdgeResult({ task: outcome().task, run: outcome(), grokbotInvoked: true });
    expect(res.grokbotInvoked).toBe(true);
    expect(res.countedAsAvoided).toBe(false);
  });
});

describe("Edge Mode: failed work is not savings", () => {
  it("never counts a failed task as avoided", () => {
    const res = buildEdgeResult({
      task: outcome().task,
      run: outcome({ worker: { status: EXECUTION_STATUS.FAILURE, summary: "no route could complete this" } })
    });
    expect(res.success).toBe(false);
    expect(res.criteriaMet).toBe(false);
    expect(res.countedAsAvoided).toBe(false);
    expect(res.criteriaReason).toMatch(/did not complete/);
  });

  it("never counts a task that missed its contract as avoided", () => {
    const res = buildEdgeResult({
      task: outcome().task,
      run: outcome(),
      criteria: { summaryContains: "budget report" }
    });
    expect(res.success).toBe(true);
    expect(res.criteriaMet).toBe(false);
    expect(res.countedAsAvoided).toBe(false);
  });

  it("enforces artifact requirements", () => {
    const res = buildEdgeResult({ task: outcome().task, run: outcome(), criteria: { requireArtifact: true } });
    expect(res.criteriaMet).toBe(false);
    expect(res.criteriaReason).toMatch(/artifact/);
  });

  it("enforces minimum evidence and summary regex", () => {
    const missingEvidence = buildEdgeResult({ task: outcome().task, run: outcome(), criteria: { minEvidence: 3 } });
    expect(missingEvidence.criteriaMet).toBe(false);
    const badRegex = buildEdgeResult({ task: outcome().task, run: outcome(), criteria: { summaryRegex: "^\\d{6}$" } });
    expect(badRegex.criteriaMet).toBe(false);
    const goodRegex = buildEdgeResult({ task: outcome().task, run: outcome(), criteria: { summaryRegex: "50\\+1 = 51" } });
    expect(goodRegex.criteriaMet).toBe(true);
  });

  it("treats an invalid summaryRegex as unmet rather than throwing", () => {
    const res = buildEdgeResult({ task: outcome().task, run: outcome(), criteria: { summaryRegex: "([unclosed" } });
    expect(res.criteriaMet).toBe(false);
    expect(res.criteriaReason).toMatch(/not a valid regular expression/);
  });
});

describe("Edge avoidance summaries", () => {
  function res(over: Partial<EdgeResult>): EdgeResult {
    return {
      mode: "edge",
      taskId: "t",
      goal: "g",
      route: "deterministic",
      routeReason: "r",
      cacheState: "miss",
      cacheLayer: null,
      cacheChecks: [],
      executor: "deterministic",
      success: true,
      status: "success",
      grokbotRequired: false,
      grokbotInvoked: false,
      countedAsAvoided: true,
      criteria: { completed: true },
      criteriaMet: true,
      criteriaReason: "ok",
      contextBefore: 100,
      contextAfter: 50,
      summary: "s",
      evidence: [],
      artifact: null,
      measurement: { contextReduction: "proxy", externalCost: "estimated", platformUsage: "unknown", note: "" },
      elapsedMs: 1,
      retries: 0,
      errors: [],
      runId: "r1",
      ...over
    };
  }

  it("publishes X/N only when every task genuinely counts", () => {
    const list = [res({}), res({}), res({}), res({}), res({}), res({})];
    expect(edgeAvoidanceSummary(list)).toBe("GrokMax avoided GrokBot on 6/6 eligible Edge tasks (all completed, contract met, no GrokBot invocation).");
  });

  it("refuses a clean ratio when a task failed, and says why", () => {
    const list = [res({}), res({ success: false, countedAsAvoided: false, criteriaMet: false, status: "failure" }), res({}), res({}), res({}), res({})];
    const line = edgeAvoidanceSummary(list);
    expect(line).toContain("5/6");
    expect(line).toMatch(/did not complete/);
    expect(line).toMatch(/Failed work is not counted/);
  });

  it("refuses a clean ratio when any task invoked GrokBot", () => {
    const list = [res({}), res({ grokbotInvoked: true, countedAsAvoided: false })];
    expect(edgeAvoidanceSummary(list)).toMatch(/invoked GrokBot/);
  });

  it("handles the empty case without dividing by zero", () => {
    expect(edgeAvoidanceSummary([])).toContain("0/0");
  });
});

describe("Edge helpers", () => {
  it("treats partial as a successful completion but not a failure", () => {
    expect(isSuccessful("success")).toBe(true);
    expect(isSuccessful("partial")).toBe(true);
    expect(isSuccessful("failure")).toBe(false);
    expect(isSuccessful("skipped")).toBe(false);
  });

  it("formats a human-readable result including the avoided verdict", () => {
    const text = formatEdgeResult(buildEdgeResult({ task: outcome().task, run: outcome() }));
    expect(text).toContain("MODE       EDGE");
    expect(text).toContain("invoked=false");
    expect(text).toContain("AVOIDED    yes");
  });

  it("exposes evaluateEdge directly for callers that want the reason only", () => {
    const r = evaluateEdge(outcome(), { completed: true });
    expect(r.met).toBe(true);
  });
});

describe("Edge accepts a real compiled pipeline outcome", () => {
  it("does not crash when context is null and compiled prompt exists", () => {
    const base = outcome({ context: null });
    const compiled: CompiledPrompt = {
      prompt: "GOAL: Calculate 50+1",
      inputChars: 0,
      outputChars: 0,
      tokensEstimate: 0,
      preserved: [],
      removed: [],
      validation: { ok: true, issues: [], preservedConstraints: [], lostConstraints: [] },
      stages: []
    };
    const full: RunOutcome = { ...base, compiled };
    const res = buildEdgeResult({ task: full.task, run: full });
    expect(res.contextBefore).toBeNull();
    expect(res.success).toBe(true);
  });
});
