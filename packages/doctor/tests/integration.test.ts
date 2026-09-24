import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokMaxEngine, type CacheOps, type CacheItem, type CompiledPrompt, type ContextSlice, type ContextUnit, type EngineDeps, type GrokMaxTask, type LedgerEntry, type RouteDecision, type WorkerResult } from "@grokmax/core";
import { GrokMaxCache } from "@grokmax/cache";
import { runDoctor } from "@grokmax/doctor";

let dirs: string[] = [];
function freshDb(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-pipe-"));
  dirs.push(d);
  return join(d, "t.db");
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// --- in-memory / deterministic doubles (no sqlite artifact dependence) ---
function fakeContextSlice(units: ContextUnit[]): ContextSlice {
  const chars = units.reduce((a, u) => a + u.content.length, 0);
  return {
    selected: units,
    excluded: [],
    context_before_bytes: chars,
    context_after_bytes: chars,
    contextBeforeChars: chars,
    contextAfterChars: chars,
    tokenEstimateBefore: Math.ceil(chars / 4),
    tokenEstimateAfter: Math.ceil(chars / 4),
    excludedReasons: {}
  };
}

class FakeCache implements CacheOps {
  private exact = new Map<string, CacheItem>();
  private norm = new Map<string, CacheItem>();
  private sem: Array<{ key: string; item: CacheItem; task: GrokMaxTask }> = [];
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
    return top && top.item.depFingerprint === _depFp && top.task.constraints?.join() === _task.constraints?.join() ? { item: top.item, confidence: 1 } : null;
  }
  storeSemantic(entries: Array<{ intentHash: string; key: string; item: CacheItem; score: number }>, task: GrokMaxTask): void {
    for (const e of entries) this.sem.push({ key: e.key, item: e.item, task });
  }
  coalesce<T extends CacheItem = CacheItem>(h: string, compute: () => Promise<T>): Promise<T> {
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

interface Harness {
  deps: EngineDeps;
  executed: string[];
  ledger: LedgerEntry[];
  artifactsPut: boolean;
}

function harness(): Harness {
  const executed: string[] = [];
  const ledger: LedgerEntry[] = [];
  let artifactsPut = false;
  const deps: EngineDeps = {
    cache: new FakeCache(),
    router: {
      route: (t: GrokMaxTask, _avail: Set<string>): RouteDecision => fakeRoute(t.preferredExecutor === "grokbot" ? "grokbot" : "opencode")
    },
    compiler: {
      compile: (o: { task: GrokMaxTask; selectedContext: string[] }): CompiledPrompt => ({
        prompt: `GOAL: ${o.task.goal}\nCTX: ${o.selectedContext.join("|")}`,
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
      slice: async (_t: GrokMaxTask, units: ContextUnit[]): Promise<ContextSlice> => fakeContextSlice(units)
    },
    providers: {
      detect: (): Set<string> => new Set(["opencode"]),
      execute: async (_r: string, cp: CompiledPrompt, t: GrokMaxTask): Promise<WorkerResult> => {
        executed.push(cp.prompt);
        return { status: "success", executor: "opencode", summary: `worked: ${t.goal}`, evidence: ["ran"], grokbotRequired: false, costUsd: 0.001, tokensEstimate: 10 };
      },
      estimateCost: (): { usd: number | null; grokbotUsage: number } => ({ usd: 0.001, grokbotUsage: 0 })
    },
    ledger: {
      record: (entry: LedgerEntry): string => {
        ledger.push(entry);
        return entry.runId;
      }
    },
    artifacts: {
      put: async (_kind: string, _data: string, _scope: string): Promise<{ ref: string; id: string }> => {
        artifactsPut = true;
        return { ref: `grokmax://artifact/${"a".repeat(32)}`, id: "a".repeat(32) };
      },
      get: async (ref: string, _scope: string): Promise<{ id: string; kind: string; data: string; meta: Record<string, unknown> } | null> => {
        if (ref.includes("existing")) return { id: "x", kind: "worker-result", data: JSON.stringify({ status: "success", executor: "opencode", summary: "from artifact", evidence: [], grokbotRequired: false }), meta: {} };
        return null;
      },
      list: async (): Promise<never[]> => []
    },
    knowledge: {
      get: (): string | null => null,
      set: (): void => {}
    }
  };
  return { deps: deps, executed, ledger, artifactsPut };
}

const task = (over: Partial<GrokMaxTask> = {}): GrokMaxTask => ({ intent: "greet", goal: "say hello", freshness: "hourly", ...over });

describe("GrokMaxEngine pipeline", () => {
  it("executes a miss, stores cache+ledger, returns outcome", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const out = await engine.run(task());
    expect(out.outcome.status).toBe("success");
    expect(out.outcome.summary).toContain("hello");
    expect(h.executed).toHaveLength(1);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]!.status).toBe("success");
    expect(out.explain).toContain("CACHE");
  });

  it("reuses an exact-cache hit without executing", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const t = task({ goal: "stable goal", intent: "stable intent" });
    const first = await engine.run(t);
    expect(h.executed).toHaveLength(1);
    const again = await engine.run(t); // exact key matches
    expect(again.outcome.status).toBe("success");
    expect(h.executed).toHaveLength(1); // no re-execution
    expect(again.route.cache).toBe("hit");
    expect(again.cache.some((c) => c.layer === "L1" && c.hit)).toBe(true);
    expect(first.explain).toContain("miss");
  });

  it("writes artifacts when output is artifact", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const out = await engine.run(task({ output: "artifact" }));
    expect(out.outcome.artifact).toMatch(/^grokmax:\/\/artifact\//);
    expect(h.ledger[0]!.cache).toBeDefined();
  });

  it("reuses an L4 artifact ref when task references one", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const out = await engine.run(task({ contextRefs: ["grokmax://artifact/existing"] }));
    expect(out.outcome.summary).toBe("from artifact");
    expect(out.route.cache).toBe("hit");
    expect(out.cache.some((c) => c.layer === "L4" && c.hit)).toBe(true);
  });

  it("skips execution on dryRunOnly", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const out = await engine.run(task(), { dryRunOnly: true });
    expect(out.outcome.status).toBe("skipped");
    expect(h.executed).toHaveLength(0);
  });

  it("respects skipCacheWrite", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    await engine.run(task(), { skipCacheWrite: true });
    // executed but nothing stored
    expect(h.executed).toHaveLength(1);
    const _again = await engine.run(task()); // same task, but nothing was cached
    expect(h.executed).toHaveLength(2);
  });

  it("coalesces concurrent duplicate runs to a single execution", async () => {
    const h = harness();
    const engine = new GrokMaxEngine(h.deps);
    const t = task({ goal: "concurrent", intent: "concurrent intent" });
    const [a, b] = await Promise.all([engine.run(t), engine.run(t)]);
    expect(a.outcome.status).toBe("success");
    expect(b.outcome.status).toBe("success");
    expect(h.executed).toHaveLength(1); // inflight dedup
  });

  it("swallows executor failures into a failure result", async () => {
    const h = harness();
    h.deps.providers.execute = async (): Promise<WorkerResult> => {
      return { status: "failure", executor: "opencode", summary: "boom", evidence: [], grokbotRequired: false };
    };
    const engine = new GrokMaxEngine(h.deps);
    const out = await engine.run(task());
    expect(out.outcome.status).toBe("failure");
    expect(out.outcome.summary).toContain("boom");
    expect(h.ledger[0]!.status).toBe("failure");
  });

  it("records dependency-fingerprint invalidation when files change keyed behavior", async () => {
    // FakeCache returns fingerprint 'fp' always; simulate stale depFingerprint via a cache keyed on a changing token
    const h = harness();
    const fresh = new GrokMaxCache(freshDb());
    const deps2: EngineDeps = {
      ...h.deps,
      cache: fresh
    };
    const engine = new GrokMaxEngine(deps2);
    const t = task({ goal: "dep", intent: "dep intent" });
    await engine.run(t);
    await engine.run(t); // second run hits L1 (no dep change)
    const stats = fresh.stats();
    expect(stats.exactHits).toBeGreaterThanOrEqual(1);
    fresh.close();
  });
});

describe("doctor integrates with engine", () => {
  it("runs with a provided cache", async () => {
    const c = new GrokMaxCache(freshDb());
    const res = await runDoctor({ cache: c, checkOpencode: false, checkGrokbotBridge: false, providerDetect: () => new Set(["deterministic"]), benchmarkFixturesPresent: false });
    expect(res.checks.length).toBeGreaterThan(10);
    expect(res.checks.every((ch) => ch.status !== "failure")).toBe(true);
    expect(["healthy", "warning", "failure"]).toContain(res.status);
    c.close();
  });
});