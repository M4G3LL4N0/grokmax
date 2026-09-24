import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokMaxCache, openStore, SqliteStore } from "@grokmax/cache";
import type { CacheItem } from "@grokmax/core";

let dirs: string[] = [];

function freshDb(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-cache-"));
  dirs.push(d);
  return join(d, "test.db");
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function item(result = "42", expiresAt: number | null = Date.now() + 60_000, depFingerprint: string | null = null): Parameters<GrokMaxCache["storeExact"]>[1] {
  return { result, expiresAt, depFingerprint, explanation: "test" };
}

describe("GrokMaxCache / L1 exact", () => {
  it("round-trips exact entries and bumps hit counters", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeExact("h1", item('"hello"'));
    const got = c.lookupExact("h1");
    expect(got?.result).toBe('"hello"');
    expect(c.stats().exactHits).toBe(1);
    expect(c.lookupExact("nope")).toBeNull();
    expect(c.stats().exactMisses).toBe(1);
    c.clearAll();
    c.close();
  });

  it("treats TTL-expired entries as misses", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeExact("exp", item('"x"', Date.now() - 1));
    expect(c.lookupExact("exp")).toBeNull();
    c.close();
  });

  it("invalidateExact removes and records", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeExact("h1", item());
    c.invalidateExact("h1", "dependency changed");
    expect(c.lookupExact("h1")).toBeNull();
    const inv = c.invalidations();
    expect(inv).toHaveLength(1);
    expect(inv[0]!.reason).toBe("dependency changed");
    c.close();
  });
});

describe("GrokMaxCache / L2 normalized", () => {
  it("round-trips normalized entries", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeNormalized("n1", item('"norm"'));
    expect(c.lookupNormalized("n1")?.result).toBe('"norm"');
    c.close();
  });

  it("expired normalized entries are misses", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeNormalized("n1", item('"norm"', Date.now() - 1));
    expect(c.lookupNormalized("n1")).toBeNull();
    c.close();
  });
});

describe("GrokMaxCache / L3 semantic", () => {
  const task = { intent: "write tests for the cache package", goal: "cover the code", constraints: ["pnpm only"], freshness: "hourly" as const };

  it("returns a hit for a near-identical stored intent", () => {
    const c = new GrokMaxCache(freshDb());
    const depFp = c.dependencyFingerprint(task);
    const nKey = "nk1";
    const itemObj = item('"sem"', Date.now() + 60_000, depFp);
    c.storeSemantic([{ intentHash: "any", key: nKey, item: itemObj, score: 1 }], task);
    const hit = c.lookupSemantic("Please could you write tests for the cache package", task, depFp);
    expect(hit).not.toBeNull();
    expect(hit!.item.result).toBe('"sem"');
    expect(hit!.confidence).toBeGreaterThan(0.85);
    c.close();
  });

  it("rejects when dependency fingerprint changed", () => {
    const c = new GrokMaxCache(freshDb());
    const storeFp = c.dependencyFingerprint(task);
    c.storeSemantic([{ intentHash: "idx", key: "nk1", item: item('"x"', Date.now() + 60_000, storeFp), score: 1 }], task);
    expect(c.lookupSemantic("write tests for the cache package", task, "different-fp")).toBeNull();
    c.close();
  });

  it("rejects when constraints differ", () => {
    const c = new GrokMaxCache(freshDb());
    const depFp = c.dependencyFingerprint(task);
    c.storeSemantic([{ intentHash: "idx", key: "nk1", item: item('"x"', Date.now() + 60_000, depFp), score: 1 }], task);
    const other = { ...task, constraints: ["yarn only"] };
    expect(c.lookupSemantic("write tests for the cache package", other, depFp)).toBeNull();
    c.close();
  });

  it("rejects when output type differs", () => {
    const c = new GrokMaxCache(freshDb());
    const depFp = c.dependencyFingerprint(task);
    c.storeSemantic([{ intentHash: "idx", key: "nk1", item: item('"x"', Date.now() + 60_000, depFp), score: 1 }], task);
    const other = { ...task, output: "artifact" as const };
    expect(c.lookupSemantic("write tests for the cache package", other, depFp)).toBeNull();
    c.close();
  });

  it("declines for requireFresh and never-cache", () => {
    const c = new GrokMaxCache(freshDb());
    const depFp = c.dependencyFingerprint(task);
    c.storeSemantic([{ intentHash: "idx", key: "nk1", item: item('"x"', Date.now() + 60_000, depFp), score: 1 }], task);
    expect(c.lookupSemantic("write tests for the cache package", { ...task, requireFresh: true }, depFp)).toBeNull();
    expect(c.lookupSemantic("write tests for the cache package", { ...task, freshness: "never-cache" as const }, depFp)).toBeNull();
    c.close();
  });

  it("rejects when requested freshness is fresher than stored", () => {
    const c = new GrokMaxCache(freshDb());
    const depFp = c.dependencyFingerprint(task);
    c.storeSemantic([{ intentHash: "idx", key: "nk1", item: item('"x"', Date.now() + 60_000, depFp), score: 1 }], { ...task, freshness: "daily" });
    const fresher = { ...task, freshness: "hourly" as const };
    expect(c.lookupSemantic("write tests for the cache package", fresher, depFp)).toBeNull();
    c.close();
  });
});

describe("prune + invalidateByPrefix + coalesce", () => {
  it("prunes expired rows", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeExact("old", item('"a"', Date.now() - 10));
    c.storeExact("new", item('"b"', Date.now() + 10_000));
    c.storeNormalized("oldn", item('"c"', Date.now() - 10));
    const r = c.prune();
    expect(r.removed).toBeGreaterThanOrEqual(2);
    c.close();
  });

  it("invalidates by hash prefix", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeExact("abc123", item());
    c.storeExact("abd999", item());
    const n = c.invalidateByPrefix("ab", "test");
    expect(n).toBe(2);
    c.close();
  });

  it("coalesces concurrent computes to a single value", async () => {
    const c = new GrokMaxCache(freshDb());
    let calls = 0;
    const compute = async (): Promise<CacheItem> => {
      calls += 1;
      return item('"coalesced"');
    };
    const [a, b] = await Promise.all([c.coalesce("k", () => compute()), c.coalesce("k", () => compute())]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    c.close();
  });

  it("clearAll wipes tables", () => {
    const c = new GrokMaxCache(freshDb());
    c.storeExact("x", item());
    c.clearAll();
    expect(c.lookupExact("x")).toBeNull();
    c.close();
  });
});

describe("SqliteStore primitives", () => {
  it("opens, migrates, bumps, stats, transactions", () => {
    const store = openStore(freshDb());
    expect(store).toBeInstanceOf(SqliteStore);
    store.bump("exact_hits", 3);
    expect(store.stat("exact_hits")).toBe(3);
    const val = store.transaction(() => {
      store.db.prepare("INSERT INTO exact_cache(hash, result, stored_at) VALUES (?, ?, ?)").run("t", "r", Date.now());
      return "done";
    });
    expect(val).toBe("done");
    const row = store.db.prepare("SELECT count(*) AS c FROM exact_cache").get() as { c: number };
    expect(row.c).toBe(1);
    store.close();
  });

  it("rolls back failed transactions", () => {
    const store = openStore(freshDb());
    expect(() =>
      store.transaction(() => {
        store.db.prepare("INSERT INTO exact_cache(hash, result, stored_at) VALUES (?, ?, ?)").run("r", "x", Date.now());
        throw new Error("boom");
      })
    ).toThrow("boom");
    const row = store.db.prepare("SELECT count(*) AS c FROM exact_cache").get() as { c: number };
    expect(row.c).toBe(0);
    store.close();
  });
});