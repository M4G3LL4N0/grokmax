import { describe, expect, it } from "vitest";
import { routeTask } from "@grokmax/router";
import type { GrokMaxTask } from "@grokmax/core";

const task = (over: Partial<GrokMaxTask>): GrokMaxTask => ({ intent: over.goal ?? "x", goal: "y", ...over });

describe("routeTask", () => {
  it("routes deterministic math to deterministic locally", () => {
    const r = routeTask(task({ goal: "Calculate 7*8 and return the integer result" }), new Set(["deterministic"]), null);
    expect(r.route).toBe("deterministic");
    expect(r.grokbotRequired).toBe(false);
    expect(r.checks.some((c) => c.label === "deterministic-local" && c.result)).toBe(true);
  });

  it("routes repo modification to opencode when available", () => {
    const r = routeTask(task({ goal: "Fix the bug in src/main.ts and add a regression test" }), new Set(["opencode"]), null);
    expect(r.route).toBe("opencode");
    expect(r.grokbotRequired).toBe(false);
  });

  it("falls back to grokbot when repo work is needed and opencode absent", () => {
    const r = routeTask(task({ goal: "Refactor the module and update the tests" }), new Set(["grokbot"]), null);
    expect(r.route).toBe("grokbot");
    expect(r.grokbotRequired).toBe(true);
  });

  it("routes research to chatgpt when available", () => {
    const r = routeTask(task({ goal: "Research the current state of the art in vector search" }), new Set(["chatgpt"]), null);
    expect(r.route).toBe("chatgpt");
  });

  it("routes grokbot-unique capability to grokbot", () => {
    const r = routeTask(task({ goal: "Log into my bank website and download the statement" }), new Set(["grokbot"]), null);
    expect(r.route).toBe("grokbot");
    expect(r.grokbotRequired).toBe(true);
  });

  it("honors explicit preferredExecutor when available", () => {
    const r = routeTask(task({ goal: "Summarize the changelog", preferredExecutor: "chatgpt" }), new Set(["chatgpt", "opencode"]), null);
    expect(r.route).toBe("chatgpt");
    expect(r.reason).toContain("preferredExecutor");
  });

  it("falls back when preferredExecutor is unavailable", () => {
    const r = routeTask(task({ goal: "Summarize the changelog", preferredExecutor: "chatgpt" }), new Set(["opencode"]), null);
    expect(r.route).toBe("opencode");
    expect(r.reason).toContain("unavailable");
  });

  it("refuses grokbot when maxGrokBotUsage is exceeded", () => {
    const r = routeTask(task({ goal: "Log into my bank website and download the statement", maxGrokBotUsage: 0 }), new Set(["grokbot"]), null);
    expect(r.route).not.toBe("grokbot");
    expect(r.budget.withinGrokBotBudget).toBe(false); // grokbot route itself was over budget
    expect(r.budget.grokbotUsageEstimate).toBe(1);
    expect(r.reason).toContain("maxGrokBotUsage");
  });

  it("returns none when no capable worker exists", () => {
    const r = routeTask(task({ goal: "Generic mundane request" }), new Set([]), null);
    expect(r.route).toBe("none");
    expect(r.cheaperThanDirect).toBe(true);
  });

  it("records routed-vs-direct token comparison", () => {
    const r = routeTask(task({ goal: "Fix the bug in src/main.ts" }), new Set(["opencode", "chatgpt"]), null);
    expect(r.cheaperThanDirect).toBe(true);
  });
});

describe("routeTask documented priority order", () => {
  it("routes generic mechanical tasks to the local API before any reasoning worker", () => {
    const r = routeTask(task({ goal: "Schedule a reminder for tomorrow at noon" }), new Set(["api", "chatgpt", "opencode"]), null);
    expect(r.route).toBe("api");
  });

  it("routes pure research to the reasoning worker even when a local API exists", () => {
    const r = routeTask(task({ goal: "Research the current state of the art in vector search" }), new Set(["api", "chatgpt"]), null);
    expect(r.route).toBe("chatgpt");
  });

  it("routes pure repo work to opencode even when a chatgpt worker exists", () => {
    const r = routeTask(task({ goal: "Fix the bug in src/main.ts and add a regression test" }), new Set(["opencode", "chatgpt"]), null);
    expect(r.route).toBe("opencode");
  });

  it("lets repository capability win for hybrid repo+research tasks", () => {
    const r = routeTask(task({ goal: "Fix the bug and summarize your changes" }), new Set(["opencode", "chatgpt"]), null);
    expect(r.route).toBe("opencode");
  });

  it("reserves grokbot as the last resort for unique capabilities", () => {
    const r = routeTask(task({ goal: "Use a browser to click login and download my bank statement" }), new Set(["opencode", "chatgpt", "api", "grokbot"]), null);
    expect(r.route).toBe("grokbot");
  });

  it("keeps the deterministic route above everything else", () => {
    const r = routeTask(task({ goal: "Calculate 7*8 and return the integer result" }), new Set(["deterministic", "grokbot", "opencode"]), null);
    expect(r.route).toBe("deterministic");
  });
});