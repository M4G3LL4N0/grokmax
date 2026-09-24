import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokMaxCache, criticalLiteralsCompatible, extractCriticalLiterals } from "@grokmax/cache";
import type { CacheItem, GrokMaxTask } from "@grokmax/core";

let dirs: string[] = [];

function freshDb(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-semantic-"));
  dirs.push(d);
  return join(d, "t.db");
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const baseTask: GrokMaxTask = { intent: "", goal: "", freshness: "hourly", constraints: [] };

function storeAndLookup(cache: GrokMaxCache, stored: string, query: string): ReturnType<GrokMaxCache["lookupSemantic"]> {
  const task = { ...baseTask, intent: stored, goal: stored };
  const depFp = cache.dependencyFingerprint(task);
  const item: CacheItem = { result: JSON.stringify({ status: "success", executor: "deterministic", summary: "cached", evidence: [], grokbotRequired: false }), expiresAt: Date.now() + 60_000, depFingerprint: depFp, explanation: "test" };
  cache.storeSemantic([{ intentHash: "idx", key: "nk1", item, score: 1 }], task);
  const queryTask = { ...task, intent: query, goal: query };
  return cache.lookupSemantic(query, queryTask, depFp);
}

/**
 * Threat pairs: these are semantically DIFFERENT requests that the old
 * tokenizer collapsed to the same significant-token set (digits stripped,
 * negation stop-listed). They MUST NOT return a semantic hit.
 */
const THREAT_PAIRS: Array<[string, string]> = [
  ["Calculate 50+1", "Calculate 500+1"],
  ["Calculate 18*7", "Calculate 19*7"],
  ["Calculate 12 - 4", "Calculate 12 + 4"],
  ["Budget is $50 for the task", "Budget is $500 for the task"],
  ["Allocate 10 MB of cache", "Allocate 100 MB of cache"],
  ["Deploy the website", "Do not deploy the website"],
  ["Deploy the website now", "Never deploy the website"],
  ["Use branch main", "Use branch staging"],
  ["Run the migrations against /repo/a", "Run the migrations against /repo/b"],
  ["Set version 1.2.0 in package.json", "Set version 1.3.0 in package.json"],
  ["Compute sha256 of hello", "Compute sha256 of world"],
  ["Use port 8080 for the server", "Use port 9090 for the server"]
];

describe("semantic cache / critical-literal gate is fail-closed", () => {
  it("criticalLiteralsCompatible detects every threat pair", () => {
    for (const [a, b] of THREAT_PAIRS) {
      expect(criticalLiteralsCompatible(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false);
    }
  });

  it("lookup() never reuses a cache entry across a threat pair", () => {
    const cache = new GrokMaxCache(freshDb());
    for (const [stored, query] of THREAT_PAIRS) {
      cache.clearAll();
      const hit = storeAndLookup(cache, stored, query);
      expect(hit, `${JSON.stringify(stored)} must NOT match ${JSON.stringify(query)}`).toBeNull();
    }
    cache.close();
  });

  it("criticalLiteralsCompatible keeps benign paraphrases compatible", () => {
    expect(criticalLiteralsCompatible("Write tests for the cache package", "Please could you write tests for the cache package")).toBe(true);
    expect(criticalLiteralsCompatible("Summarize the architecture of this repository", "Give me a high-level architecture summary for this repo")).toBe(true);
    expect(criticalLiteralsCompatible("Run the tests in the top-level directory", "Run every test from the root of the repo")).toBe(true);
  });

  it("still allows a near-identical stored/query pair to hit", () => {
    const cache = new GrokMaxCache(freshDb());
    const hit = storeAndLookup(cache, "Write tests for the cache package", "Please could you write tests for the cache package");
    expect(hit).not.toBeNull();
    cache.close();
  });

  it("still hits on identical math", () => {
    const cache = new GrokMaxCache(freshDb());
    const hit = storeAndLookup(cache, "Calculate 50+1", "Calculate 50+1");
    expect(hit).not.toBeNull();
    cache.close();
  });
});

describe("extractCriticalLiterals", () => {
  it("keeps numbers with signs and decimals distinct", () => {
    const a = extractCriticalLiterals("Calculate 50+1");
    const b = extractCriticalLiterals("Calculate 500+1");
    expect(a.numbers).toEqual(["1", "50"]);
    expect(b.numbers).toEqual(["1", "500"]);
    expect(a.mathShapes).toEqual(["N+N"]);
    expect(b.mathShapes).toEqual(a.mathShapes);
  });

  it("keeps paths, versions, currencies, hashes, negation", () => {
    const a = extractCriticalLiterals("Run against /repo/a with branch staging at $50, version 1.2.0");
    expect(a.paths).toContain("/repo/a");
    expect(a.currencies).toContain("$50");
    expect(a.versions).toContain("1.2.0");
    expect(a.keywords).toContain("branch:staging");
  });

  it("flags negation and modality words", () => {
    const d = extractCriticalLiterals("Do not deploy the website only after approval");
    expect(d.negation).toContain("not");
    expect(d.negation).toContain("do not");
    expect(d.modality).toContain("only");
    expect(d.modality).toContain("after");
  });

  it("never collides 18*7 with 19*7 on math shape alone", () => {
    const a = extractCriticalLiterals("Calculate 18*7");
    const b = extractCriticalLiterals("Calculate 19*7");
    expect(a.mathShapes).toEqual(b.mathShapes);
    expect(a.numbers).not.toEqual(b.numbers);
  });
});