import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokMaxCache, openStore, significantTokens, SqliteStore } from "@grokmax/cache";
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

  it("keeps numerals, operators, amounts, and negation in the similarity key", () => {
    expect(significantTokens("Calculate 7*8 and return the integer result")).toContain("7*8");
    expect(significantTokens("Calculate 50+1 and return the integer result")).toContain("50+1");
    expect(significantTokens("Calculate 500+1 and return the integer result")).toContain("500+1");
    expect(significantTokens("Transfer $50 to the vendor")).toContain("$50");
    expect(significantTokens("Transfer $500 to the vendor")).toContain("$500");
    expect(significantTokens("Do not deploy the service")).toContain("not");
    expect(significantTokens("Don't deploy the service")).toContain("not");
    expect(significantTokens("Never deploy the service")).toContain("never");
  });

  it("does not reuse 7*8 for 50+1 or 500+1", () => {
    const c = new GrokMaxCache(freshDb());
    const stored = {
      intent: "Calculate 7*8 and return the integer result",
      goal: "math",
      constraints: [] as string[],
      freshness: "hourly" as const
    };
    const depFp = c.dependencyFingerprint(stored);
    c.storeSemantic(
      [{ intentHash: "idx", key: "nk1", item: item("7*8 = 56", Date.now() + 60_000, depFp), score: 1 }],
      stored
    );

    const fifty = { ...stored, intent: "Calculate 50+1 and return the integer result" };
    const fiveHundred = { ...stored, intent: "Calculate 500+1 and return the integer result" };
    expect(c.lookupSemantic(fifty.intent, fifty, depFp)).toBeNull();
    expect(c.lookupSemantic(fiveHundred.intent, fiveHundred, depFp)).toBeNull();

    c.storeSemantic(
      [{ intentHash: "idx2", key: "nk2", item: item("500+1 = 501", Date.now() + 60_000, depFp), score: 1 }],
      fiveHundred
    );
    expect(c.lookupSemantic(fifty.intent, fifty, depFp)).toBeNull();
    c.close();
  });

  it("still reuses a paraphrase of the same arithmetic expression", () => {
    const c = new GrokMaxCache(freshDb());
    const stored = {
      intent: "Calculate 7*8 and return the integer result",
      goal: "math",
      constraints: [] as string[],
      freshness: "hourly" as const
    };
    const depFp = c.dependencyFingerprint(stored);
    c.storeSemantic(
      [{ intentHash: "idx", key: "nk1", item: item("7*8 = 56", Date.now() + 60_000, depFp), score: 1 }],
      stored
    );
    const hit = c.lookupSemantic("Please calculate 7*8 and return the integer result", stored, depFp);
    expect(hit?.item.result).toBe("7*8 = 56");
    c.close();
  });

  it("does not treat a negated deploy as the positive deploy", () => {
    const c = new GrokMaxCache(freshDb());
    const negative = {
      intent: "Do not deploy the service",
      goal: "ship",
      constraints: [] as string[],
      freshness: "hourly" as const
    };
    const positive = { ...negative, intent: "Deploy the service" };
    const depFp = c.dependencyFingerprint(negative);
    c.storeSemantic(
      [{ intentHash: "idx", key: "nk1", item: item("skipped deploy", Date.now() + 60_000, depFp), score: 1 }],
      negative
    );
    expect(c.lookupSemantic(positive.intent, positive, depFp)).toBeNull();
    c.close();

    const onlyPositive = new GrokMaxCache(freshDb());
    const dep2 = onlyPositive.dependencyFingerprint(positive);
    onlyPositive.storeSemantic(
      [{ intentHash: "idx2", key: "nk2", item: item("deployed", Date.now() + 60_000, dep2), score: 1 }],
      positive
    );
    expect(onlyPositive.lookupSemantic(negative.intent, negative, dep2)).toBeNull();
    expect(onlyPositive.lookupSemantic("Don't deploy the service", { ...negative, intent: "Don't deploy the service" }, dep2)).toBeNull();
    onlyPositive.close();
  });

  it("does not collide $50 with $500, including inside a long shared prompt", () => {
    const c = new GrokMaxCache(freshDb());
    const fifty = {
      intent: "Transfer $50 to the vendor",
      goal: "pay",
      constraints: [] as string[],
      freshness: "hourly" as const
    };
    const fiveHundred = { ...fifty, intent: "Transfer $500 to the vendor" };
    const depFp = c.dependencyFingerprint(fifty);
    c.storeSemantic(
      [{ intentHash: "idx", key: "nk1", item: item("paid 50", Date.now() + 60_000, depFp), score: 1 }],
      fifty
    );
    expect(c.lookupSemantic(fiveHundred.intent, fiveHundred, depFp)).toBeNull();

    const shared =
      "Please calculate the quarterly vendor payment and return the integer result for invoice processing across all regions today before sending the approved transfer of";
    const longFifty = { ...fifty, intent: `${shared} $50` };
    const longFiveHundred = { ...fifty, intent: `${shared} $500` };
    c.storeSemantic(
      [{ intentHash: "idx2", key: "nk2", item: item("paid 50 long", Date.now() + 60_000, depFp), score: 1 }],
      longFifty
    );
    expect(c.lookupSemantic(longFiveHundred.intent, longFiveHundred, depFp)).toBeNull();
    c.close();
  });

  it("does not drop a negation buried in an otherwise identical long prompt", () => {
    const c = new GrokMaxCache(freshDb());
    const positive = {
      intent: "Please deploy the production service to the staging environment after the scheduled review meeting with the operations team",
      goal: "ship",
      constraints: [] as string[],
      freshness: "hourly" as const
    };
    const negative = {
      ...positive,
      intent: "Please do not deploy the production service to the staging environment after the scheduled review meeting with the operations team"
    };
    const depFp = c.dependencyFingerprint(positive);
    c.storeSemantic(
      [{ intentHash: "idx", key: "nk1", item: item("deployed", Date.now() + 60_000, depFp), score: 1 }],
      positive
    );
    expect(c.lookupSemantic(negative.intent, negative, depFp)).toBeNull();
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