import { describe, expect, it } from "vitest";
import { buildMicroPrompt, formatPreflight, preflight, verifyInbotInvocation, type PreflightResult } from "@grokmax/inbot";
import type { CacheLookup, GrokMaxTask, RouteDecision } from "@grokmax/core";

function task(over: Partial<GrokMaxTask> = {}): GrokMaxTask {
  return { intent: "summarize the changelog", goal: "Summarize the changelog", contextRefs: ["README.md"], ...over };
}

function decision(over: Partial<RouteDecision> = {}): RouteDecision {
  return {
    route: "chatgpt",
    reason: "reasoning/research best served by ChatGPT-capable worker",
    grokbotRequired: false,
    cache: "miss",
    budget: { withinUsdBudget: true, estimatedUsd: 0.01, maxUsd: null, withinGrokBotBudget: true, grokbotUsageEstimate: 0, maxGrokBotUsage: null },
    checks: [],
    cheaperThanDirect: true,
    ...over
  };
}

const miss: CacheLookup[] = [{ layer: "L1", hit: false, reason: "no exact cache entry" }];
const hit: CacheLookup[] = [
  { layer: "L1", hit: true, reason: "exact hit" },
  { layer: "L2", hit: false, reason: "not consulted" }
];

describe("In-Bot preflight: RETURN_EXISTING_RESULT", () => {
  it("returns an existing cached result without asking GrokBot to work", () => {
    const r = preflight({
      task: task(),
      route: decision(),
      cache: hit,
      existing: { summary: "the changelog adds caching", status: "success" },
      taskId: "pf-1"
    });
    expect(r.action).toBe("RETURN_EXISTING_RESULT");
    expect(r.mode).toBe("inbot");
    expect(r.grokbotWorkRequired).toBe(false);
    expect(r.summary).toBe("the changelog adds caching");
    expect(r.cache.state).toBe("hit");
    expect(r.cache.layer).toBe("L1");
    expect(r.instruction).toMatch(/Do not redo/);
  });

  it("carries the artifact reference through when the cached result has one", () => {
    const r = preflight({
      task: task(),
      route: decision(),
      cache: hit,
      existing: { summary: "s", status: "success", artifact: "grokmax://artifact/abc" },
      taskId: "pf-2"
    });
    expect(r.artifact).toBe("grokmax://artifact/abc");
  });

  it("does not return a failed existing result as a hit", () => {
    const r = preflight({
      task: task(),
      route: decision(),
      cache: miss,
      existing: { summary: "failed", status: "failure" },
      taskId: "pf-3"
    });
    expect(r.action).not.toBe("RETURN_EXISTING_RESULT");
  });

  it("prefers returning an existing result even when the router would have used GrokBot", () => {
    const r = preflight({
      task: task(),
      route: decision({ route: "grokbot", grokbotRequired: true, reason: "authenticated browser" }),
      cache: hit,
      existing: { summary: "already done", status: "success" },
      taskId: "pf-4"
    });
    expect(r.action).toBe("RETURN_EXISTING_RESULT");
    expect(r.grokbotWorkRequired).toBe(false);
  });
});

describe("In-Bot preflight: DELEGATE", () => {
  it("delegates repository engineering to opencode", () => {
    const r = preflight({
      task: task({ goal: "Refactor the parser module" }),
      route: decision({ route: "opencode", reason: "repository modification/inspection required" }),
      cache: miss,
      taskId: "pf-5"
    });
    expect(r.action).toBe("DELEGATE");
    expect(r.grokbotWorkRequired).toBe(false);
    expect(r.delegateTo).toBe("opencode");
    expect(r.microPrompt).toContain("Refactor the parser module");
    expect(r.instruction).toMatch(/Do not perform this task yourself/);
  });

  it("delegates advisory work to chatgpt", () => {
    const r = preflight({ task: task({ goal: "Plan the migration" }), route: decision(), cache: miss, taskId: "pf-6" });
    expect(r.action).toBe("DELEGATE");
    expect(r.delegateTo).toBe("chatgpt");
  });

  it("tells GrokBot not to independently redo the delegate's work", () => {
    const r = preflight({ task: task({ goal: "Refactor the parser" }), route: decision({ route: "opencode" }), cache: miss, taskId: "pf-7" });
    expect(r.instruction).toMatch(/Do not independently redo/);
  });
});

describe("In-Bot preflight: GROKBOT_REQUIRED", () => {
  it("requires GrokBot for authenticated browser work and supplies a micro-prompt", () => {
    const r = preflight({
      task: task({ goal: "Log into my bank portal and download the statement" }),
      route: decision({ route: "grokbot", grokbotRequired: true, reason: "task uniquely benefits from GrokBot-specific capabilities" }),
      cache: miss,
      taskId: "pf-8"
    });
    expect(r.action).toBe("GROKBOT_REQUIRED");
    expect(r.grokbotWorkRequired).toBe(true);
    expect(r.microPrompt).toContain("Log into my bank portal");
    expect(r.microPrompt).toContain("SCOPE: perform only the GrokBot-specific portion");
    expect(r.instruction).toMatch(/Do not ingest context you were not given/);
    expect(r.instruction).toMatch(/do not redo repository engineering/);
  });

  it("includes constraints verbatim in the micro-prompt", () => {
    const r = preflight({
      task: task({ goal: "Submit the form", constraints: ["do not exceed 250 USD", "use account 4471"] }),
      route: decision({ route: "grokbot", grokbotRequired: true }),
      cache: miss,
      taskId: "pf-9"
    });
    expect(r.microPrompt).toContain("do not exceed 250 USD");
    expect(r.microPrompt).toContain("use account 4471");
  });
});

describe("In-Bot preflight: FAIL", () => {
  it("fails rather than spending when no route can run", () => {
    const r = preflight({
      task: task(),
      route: decision({ route: "none", reason: "no capable worker available; nothing executable" }),
      cache: miss,
      taskId: "pf-10"
    });
    expect(r.action).toBe("FAIL");
    expect(r.grokbotWorkRequired).toBe(false);
    expect(r.instruction).toMatch(/Do not spend/);
  });
});

describe("In-Bot contract shape", () => {
  it("always returns every required field for a machine consumer", () => {
    const r: PreflightResult = preflight({ task: task(), route: decision(), cache: miss, taskId: "pf-11" });
    for (const key of ["action", "mode", "grokbotWorkRequired", "reason", "instruction", "summary", "artifact", "microPrompt", "contextRefs", "delegateTo", "cache", "route", "evidenceClass", "taskId", "generatedAt"] as const) {
      expect(r).toHaveProperty(key);
    }
    expect(r.contextRefs).toEqual(["README.md"]);
  });

  it("is JSON-serializable without loss", () => {
    const r = preflight({ task: task(), route: decision(), cache: miss, taskId: "pf-12" });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("In-Bot invocation verification", () => {
  it("verifies a GrokBot run that followed a GROKBOT_REQUIRED preflight", () => {
    const v = verifyInbotInvocation({
      preflightTaskId: "pf-8",
      preflightAction: "GROKBOT_REQUIRED",
      preflightGeneratedAt: "2024-01-01T00:00:00.000Z",
      preflightSaidGrokbotRequired: true,
      grokbotRunId: "run-1"
    });
    expect(v.verified).toBe(true);
  });

  it("rejects a GrokBot run that did not come from an In-Bot preflight", () => {
    const v = verifyInbotInvocation({
      preflightTaskId: "pf-5",
      preflightAction: "DELEGATE",
      preflightGeneratedAt: "2024-01-01T00:00:00.000Z",
      preflightSaidGrokbotRequired: false,
      grokbotRunId: "run-2"
    });
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/not an In-Bot sanctioned invocation/);
  });

  it("rejects a proof where preflight did not actually mark GrokBot required", () => {
    const v = verifyInbotInvocation({
      preflightTaskId: "pf-8",
      preflightAction: "GROKBOT_REQUIRED",
      preflightGeneratedAt: "2024-01-01T00:00:00.000Z",
      preflightSaidGrokbotRequired: false,
      grokbotRunId: "run-3"
    });
    expect(v.verified).toBe(false);
  });
});

describe("In-Bot micro-prompt", () => {
  it("stays compact and never dumps the whole repository", () => {
    const p = buildMicroPrompt(task({ goal: "Do the thing", constraints: ["a", "b"] }));
    expect(p.split("\n").length).toBeLessThan(20);
    expect(p).toContain("CONTEXT REFS: README.md");
  });

  it("omits an intent line that duplicates the goal", () => {
    const p = buildMicroPrompt({ intent: "same", goal: "same" });
    expect(p).not.toContain("INTENT:");
  });

  it("formats a readable text contract", () => {
    const r = preflight({ task: task(), route: decision(), cache: miss, taskId: "pf-13" });
    const text = formatPreflight(r);
    expect(text).toContain("ACTION     DELEGATE");
    expect(text).toContain("MICRO-PROMPT");
  });
});
