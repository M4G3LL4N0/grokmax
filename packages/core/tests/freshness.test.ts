import { describe, expect, it } from "vitest";
import { GrokMaxEngine, type CacheOps, type CacheItem, type CompiledPrompt, type ContextSlice, type ContextUnit, type EngineDeps, type GrokMaxTask, type LedgerEntry, type RouteDecision, type WorkerResult } from "@grokmax/core";

class FakeCache implements CacheOps {
  private exact = new Map<string, CacheItem>();
  private norm = new Map<string, CacheItem>();
  private sem: Array<{ item: CacheItem; task: GrokMaxTask }> = [];
  exactHits = 0;
  exactMisses = 0;

  lookupExact(h: string): CacheItem | null {
    if (this.exact.has(h)) {
      this.exactHits += 1;
      return this.exact.get(h)!;
    }
    this.exactMisses += 1;
    return null;
  }
  storeExact(h: string, i: CacheItem): void {
    this.exact.set(h, i);
  }
  invalidateExact(h: string, _e: string): void {
    this.exact.delete(h);
  }
  lookupNormalized(h: string): CacheItem | null {
    return this.norm.get(h) ?? null;
  }
  storeNormalized(h: string, i: CacheItem): void {
    this.norm.set(h, i);
  }
  lookupSemantic(_intent: string, _task: GrokMaxTask, _depFp: string) {
    const top = this.sem[this.sem.length - 1];
    return top ? { item: top.item, confidence: 1 } : null;
  }
  storeSemantic(entries: Array<{ item: CacheItem }>, task: GrokMaxTask): void {
    for (const e of entries) this.sem.push({ item: e.item, task });
  }
  coalesce<T extends CacheItem = CacheItem>(_h: string, compute: () => Promise<T>): Promise<T> {
    return compute();
  }
  dependencyFingerprint(_task: GrokMaxTask): string {
    return "fp";
  }
  stats() {
    return { exactHits: this.exactHits, exactMisses: this.exactMisses, normalizedHits: 0, semanticHits: 0, semanticMisses: 0, coalesced: 0, size: 0 };
  }
}

function fakeRoute(route: RouteDecision["route"]): RouteDecision {
  return {
    route,
    reason: `${route} route`,
    grokbotRequired: route === "grokbot",
    cache: "miss",
    budget: { withinUsdBudget: true, estimatedUsd: 0, maxUsd: null, withinGrokBotBudget: true, grokbotUsageEstimate: 0, maxGrokBotUsage: null },
    checks: [],
    cheaperThanDirect: true
  };
}

function harness() {
  const executed: string[] = [];
  const ledger: LedgerEntry[] = [];
  const cache = new FakeCache();
  const deps: EngineDeps = {
    cache,
    router: {
      route: (_t: GrokMaxTask): RouteDecision => fakeRoute("opencode")
    },
    compiler: {
      compile: (o: { task: GrokMaxTask; selectedContext: string[] }): CompiledPrompt => ({
        prompt: `GOAL: ${o.task.goal}`,
        inputChars: 0,
        outputChars: 0,
        tokensEstimate: 0,
        preserved: o.task.constraints ?? [],
        removed: [],
        validation: { ok: true, issues: [], preservedConstraints: o.task.constraints ?? [], lostConstraints: [] },
        stages: []
      })
    },
    context: {
      slice: async (_t: GrokMaxTask, units: ContextUnit[]): Promise<ContextSlice> => ({
        selected: units,
        excluded: [],
        context_before_bytes: 0,
        context_after_bytes: 0,
        contextBeforeChars: 0,
        contextAfterChars: 0,
        tokenEstimateBefore: 0,
        tokenEstimateAfter: 0,
        excludedReasons: {}
      })
    },
    providers: {
      detect: () => new Set(["opencode"]),
      execute: async (_r: string, cp: CompiledPrompt, t: GrokMaxTask): Promise<WorkerResult> => {
        executed.push(cp.prompt);
        return { status: "success", executor: "opencode", summary: `worked: ${t.goal}`, evidence: ["ran"], grokbotRequired: false, costUsd: 0.001, tokensEstimate: 10 };
      },
      estimateCost: () => ({ usd: 0.001, grokbotUsage: 0 })
    },
    ledger: {
      record: (entry: LedgerEntry): string => {
        ledger.push(entry);
        return entry.runId;
      }
    },
    artifacts: {
      put: async (): Promise<{ ref: string; id: string }> => ({ ref: "grokmax://artifact/x", id: "x" }),
      get: async (ref: string, _scope: string) => {
        if (ref.includes("existing")) return { id: "x", kind: "worker-result", data: JSON.stringify({ status: "success", executor: "opencode", summary: "from artifact", evidence: [], grokbotRequired: false }), meta: {} };
        return null;
      },
      list: async () => []
    }
  };
  return { deps, executed, ledger, cache };
}

const task = (over: Partial<GrokMaxTask> = {}): GrokMaxTask => ({ intent: "stable intent", goal: "stable goal", freshness: "hourly", ...over });

describe("--fresh / requireFresh bypasses every answer cache", () => {
  it("requireFresh re-executes a task that otherwise would have hit L1", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const t = task();

    const first = await engine.run(t);
    expect(first.outcome.status).toBe("success");
    expect(h.executed).toHaveLength(1);

    // Normal rerun is served from L1.
    const cachedRun = await engine.run(t);
    expect(cachedRun.cache.some((c) => c.layer === "L1" && c.hit)).toBe(true);
    expect(h.executed).toHaveLength(1);

    // requireFresh rerun bypasses L1/L2/L3/L4/L5 and executes again.
    const freshRun = await engine.run(task({ requireFresh: true }));
    expect(h.executed).toHaveLength(2);
    expect(freshRun.route.cache).toBe("miss");
    expect(freshRun.cache.some((c) => c.hit && c.layer !== "L0")).toBe(false);
    expect(freshRun.cache.some((c) => c.layer === "L1" && c.hit)).toBe(false);
    expect(h.ledger).toHaveLength(3);
  });

  it("requireFresh does not reuse an L4 artifact that would serve a prior answer", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const withArtifact = task({ contextRefs: ["grokmax://artifact/existing"] });

    const served = await engine.run(withArtifact);
    expect(served.outcome.summary).toBe("from artifact");

    const fresh = await engine.run(task({ contextRefs: ["grokmax://artifact/existing"], requireFresh: true }));
    expect(fresh.cache.some((c) => c.layer === "L4" && c.hit)).toBe(false);
    expect(h.executed.length).toBeGreaterThanOrEqual(1);
  });

  it("requireFresh failures are recorded in the ledger like any other run", async () => {
    const h = harness();
    h.deps.providers.execute = async (): Promise<WorkerResult> => ({ status: "failure", executor: "opencode", summary: "boom", evidence: [], grokbotRequired: false });
    const engine = new GrokMaxEngine(h.deps);
    const out = await engine.run(task({ requireFresh: true }));
    expect(out.outcome.status).toBe("failure");
    expect(h.ledger[0]!.status).toBe("failure");
  });
});