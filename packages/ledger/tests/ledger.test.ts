import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "@grokmax/cache";
import { Ledger, kindOf } from "@grokmax/ledger";
import type { LedgerEntry, RouteDecision } from "@grokmax/core";

let dirs: string[] = [];
function freshStore() {
  const d = mkdtempSync(join(tmpdir(), "grokmax-ledger-"));
  dirs.push(d);
  return openStore(join(d, "t.db"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function fakeRoute(grokbot: boolean): RouteDecision {
  return {
    route: grokbot ? "grokbot" : "deterministic",
    reason: "test",
    grokbotRequired: grokbot,
    cache: "miss",
    budget: { withinUsdBudget: true, estimatedUsd: 0.01, maxUsd: null, withinGrokBotBudget: true, grokbotUsageEstimate: grokbot ? 1 : 0, maxGrokBotUsage: null },
    checks: [],
    cheaperThanDirect: true
  };
}

function fakeEntry(runId: string, route: boolean, status: "success" | "failure", cacheHits = false): LedgerEntry {
  return {
    runId,
    taskText: "task",
    intent: "t",
    goal: "g",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    elapsedMs: 1000,
    cache: cacheHits ? [{ layer: "L1", hit: true, reason: "hit" }] : [{ layer: "L1", hit: false, reason: "miss" }],
    route: fakeRoute(route),
    context: null,
    compiled: null,
    worker: null,
    retries: status === "failure" ? 1 : 0,
    errors: status === "failure" ? ["err"] : [],
    humanIntervention: false,
    measured: {},
    status
  };
}

describe("Ledger", () => {
  it("records, reads, lists, counts", () => {
    const store = freshStore();
    const l = new Ledger(store);
    const id = l.record(fakeEntry("r1", false, "success"));
    expect(id).toBe("r1");
    expect(l.get("r1")).not.toBeNull();
    expect(l.count()).toBe(1);
    expect(l.list()).toHaveLength(1);
    store.close();
  });

  it("updateMeasurements overwrites only measured field", () => {
    const store = freshStore();
    const l = new Ledger(store);
    l.record(fakeEntry("r1", true, "success"));
    expect(l.updateMeasurements("r1", { grokbotCalls: 0, providerCostUsd: 0.002 })).toBe(true);
    const e = l.get("r1");
    expect(e?.measured.grokbotCalls).toBe(0);
    expect(e?.measured.providerCostUsd).toBe(0.002);
    expect(l.updateMeasurements("nope", { grokbotCalls: 1 })).toBe(false);
    store.close();
  });

  it("summary distinguishes measured vs estimated avoidance", () => {
    const store = freshStore();
    const l = new Ledger(store);
    // measured: called 0 times
    l.record(fakeEntry("r1", false, "success"));
    l.updateMeasurements("r1", { grokbotCalls: 0 });
    // proxy: route avoided but nothing measured
    l.record(fakeEntry("r2", false, "success"));
    // used grokbot (measured 1)
    l.record(fakeEntry("r3", true, "success"));
    l.updateMeasurements("r3", { grokbotCalls: 1 });
    // failed run
    l.record(fakeEntry("r4", false, "failure"));

    const s = l.summary();
    expect(s.runs).toBe(4);
    expect(s.successes).toBe(3);
    expect(s.failures).toBe(1);
    expect(s.cacheHits).toBe(0);
    expect(s.grokbotUsed).toBe(1);
    expect(s.grokbotAvoidedEstimate).toBe(3); // every non-grokbot route
    expect(s.measuredGrokbotAvoided).toBe(1); // ONLY genuinely measured zero-call runs (r1)
    expect(s.errors).toBe(1);
    expect(s.retries).toBe(1);
    store.close();
  });

  it("exports raw rows with honesty note", () => {
    const store = freshStore();
    const l = new Ledger(store);
    l.record(fakeEntry("r1", false, "success"));
    const ex = l.exports();
    expect(ex.raw).toHaveLength(1);
    expect(ex.note).toContain("never presented as measurements");
    store.close();
  });
});

describe("kindOf", () => {
  it("classifies fields honestly", () => {
    expect(kindOf("grokbotCalls")).toBe("measured");
    expect(kindOf("providerCostUsd")).toBe("measured");
    expect(kindOf("tokensEstimate")).toBe("estimated");
    expect(kindOf("elapsedMs")).toBe("estimated");
    expect(kindOf("contextBeforeChars")).toBe("proxy");
    expect(kindOf("contextAfterChars")).toBe("proxy");
    expect(kindOf("anything-else")).toBe("unknown");
  });
});