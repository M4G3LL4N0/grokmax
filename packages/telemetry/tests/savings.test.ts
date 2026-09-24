import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "@grokmax/cache";
import { Ledger } from "@grokmax/ledger";
import { computeSavings, savingsLine } from "@grokmax/telemetry";
import type { LedgerEntry, RouteDecision } from "@grokmax/core";
import { GrokMaxCache } from "@grokmax/cache";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-savings-"));
  dirs.push(d);
  return d;
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

function entry(runId: string, routeGrokbot: boolean, measured: { grokbotCalls?: number } = {}): LedgerEntry {
  return {
    runId,
    taskText: "task",
    intent: "t",
    goal: "g",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    elapsedMs: 1000,
    cache: [{ layer: "L1", hit: false, reason: "miss" }],
    route: fakeRoute(routeGrokbot),
    context: { selected: [], excluded: [], context_before_bytes: 1000, context_after_bytes: 500, contextBeforeChars: 1000, contextAfterChars: 500, tokenEstimateBefore: 250, tokenEstimateAfter: 125, excludedReasons: {} },
    compiled: null,
    worker: null,
    retries: 0,
    errors: [],
    humanIntervention: false,
    measured,
    status: "success"
  };
}

async function makeCache(): Promise<GrokMaxCache> {
  const dbPath = join(freshDir(), "cache.db");
  return new GrokMaxCache(dbPath);
}

describe("computeSavings never mixes denominators", () => {
  it("labels a report 'measured' only when every row has measured data", async () => {
    const cache = await makeCache();
    const store = openStore(join(freshDir(), "t.db"));
    const ledger = new Ledger(store);
    ledger.record(entry("m1", false, { grokbotCalls: 0 }));
    ledger.record(entry("m2", false, { grokbotCalls: 0 }));
    const r = await computeSavings(cache, ledger);
    expect(r.method).toBe("measured");
    expect(r.eligibleTasks).toBe(2);
    expect(r.tasksAvoidingGrokBot).toBe(2);
    cache.close();
    store.close();
  });

  it("labels a report 'proxy' when no row has measured data", async () => {
    const cache = await makeCache();
    const store = openStore(join(freshDir(), "t.db"));
    const ledger = new Ledger(store);
    ledger.record(entry("p1", false));
    ledger.record(entry("p2", true));
    const r = await computeSavings(cache, ledger);
    expect(r.method).toBe("proxy");
    expect(r.tasksAvoidingGrokBot).toBe(1);
    cache.close();
    store.close();
  });

  it("labels a report 'mixed' when some rows are measured and some are not, counting only measured rows", async () => {
    const cache = await makeCache();
    const store = openStore(join(freshDir(), "t.db"));
    const ledger = new Ledger(store);
    ledger.record(entry("m1", false, { grokbotCalls: 0 }));
    ledger.record(entry("p1", false));
    ledger.record(entry("p2", true));
    const r = await computeSavings(cache, ledger);
    expect(r.method).toBe("mixed");
    // Denominator is the measured row only; the two proxy rows are NOT folded in.
    expect(r.eligibleTasks).toBe(1);
    expect(r.tasksAvoidingGrokBot).toBe(1);
    expect(r.caveats.some((c) => c.includes("Mixed report"))).toBe(true);
    expect(savingsLine(r)).toContain("measured rows only");
    cache.close();
    store.close();
  });

  it("a task measured WITH grokbotCalls>0 is counted as requiring GrokBot, never as avoided", async () => {
    const cache = await makeCache();
    const store = openStore(join(freshDir(), "t.db"));
    const ledger = new Ledger(store);
    ledger.record(entry("used", false, { grokbotCalls: 3 }));
    const r = await computeSavings(cache, ledger);
    expect(r.method).toBe("measured");
    expect(r.tasksAvoidingGrokBot).toBe(0);
    expect(r.tasksRequiringGrokBot).toBe(1);
    cache.close();
    store.close();
  });
});