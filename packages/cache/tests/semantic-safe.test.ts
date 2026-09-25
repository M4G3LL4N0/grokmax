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
  ["Use port 8080 for the server", "Use port 9090 for the server"],
  ["Use operator +", "Use operator *"],
  ["Use + then *", "Use * then +"],
  // Order-sensitive procedures. Identical bag-of-words, inverted operation
  // order. These were an unsafe reuse class: Jaccard scored them 1.0.
  ["Roll back the deploy first, then drain nodes", "Drain nodes first, then roll back the deploy"],
  ["Roll back first, then drain", "Drain first, then roll back"],
  ["Backup database before truncate", "Truncate database before backup"],
  ["Approve then merge", "Merge then approve"],
  ["Revoke key before issuing replacement", "Issue replacement before revoking key"],
  ["Stop the service, then apply the migration", "Apply the migration, then stop the service"],
  ["Take a backup, then truncate the log table", "Truncate the log table, then take a backup"],
  ["Approve the change, then merge the pull request", "Merge the pull request, then approve the change"],
  ["Revoke the old key, then issue a replacement key", "Issue a replacement key, then revoke the old key"]
];

/**
 * Ordered procedures whose meaning is preserved. The gate must accept these:
 * a fail-closed order check that rejects true paraphrases is also a bug.
 */
const ORDER_SAFE_PAIRS: Array<[string, string]> = [
  ["Back up the database first, then truncate the log.", "First back up the database; afterwards truncate the log."],
  ["Back up the database first, then truncate the log.", "Back up the database, then truncate the log."],
  ["Stop the service, then apply the migration", "First stop the service, then apply the migration"]
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

  it("rejects order-inverted procedures whose bag-of-words is identical", () => {
    for (const [a, b] of THREAT_PAIRS.filter(([a]) => /\b(first|then|before|after|next|finally)\b/i.test(a))) {
      expect(criticalLiteralsCompatible(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false);
    }
  });

  it("lookup() never reuses a cached answer for an order-inverted procedure", () => {
    const cache = new GrokMaxCache(freshDb());
    const orderPairs = THREAT_PAIRS.filter(([a]) => /\b(first|then|before|after|next|finally)\b/i.test(a));
    for (const [storedIntent, queryIntent] of orderPairs) {
      cache.clearAll();
      expect(
        storeAndLookup(cache, storedIntent, queryIntent),
        `${JSON.stringify(storedIntent)} must NOT be served to ${JSON.stringify(queryIntent)}`
      ).toBeNull();
    }
    cache.close();
  });

  it("keeps order-preserving paraphrases of a procedure compatible", () => {
    for (const [a, b] of ORDER_SAFE_PAIRS) {
      expect(criticalLiteralsCompatible(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(true);
    }
  });

  it("still reuses a cached answer for an order-preserving paraphrase", () => {
    const cache = new GrokMaxCache(freshDb());
    const hit = storeAndLookup(cache, ORDER_SAFE_PAIRS[1]![0], ORDER_SAFE_PAIRS[1]![1]);
    expect(hit).not.toBeNull();
    cache.close();
  });

  it("does not treat ordinary paraphrase as order-sensitive when no marker is present", () => {
    // No sequencing marker => no order fingerprint => ordinary paraphrase reuse
    // is untouched by the order gate.
    expect(extractCriticalLiterals("Summarize the architecture of this repository").order).toEqual([]);
    expect(extractCriticalLiterals("Back up the database first, then truncate the log.").order).not.toEqual([]);
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

  it("misses bare + probed as bare * (Gate B)", () => {
    const cache = new GrokMaxCache(freshDb());
    const hit = storeAndLookup(cache, "Use operator +", "Use operator *");
    expect(hit).toBeNull();
    const same = storeAndLookup(cache, "Use operator +", "Please use operator +");
    expect(same).not.toBeNull();
    cache.close();
  });

  it("still hits a paraphrase of the same spaced expression", () => {
    const cache = new GrokMaxCache(freshDb());
    const hit = storeAndLookup(cache, "Calculate 12 - 4", "Please calculate 12 - 4");
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

  it("treats bare operators as ordered critical literals and leaves glued math alone", () => {
    expect(extractCriticalLiterals("Use operator +").operators).toEqual(["+"]);
    expect(extractCriticalLiterals("Use operator *").operators).toEqual(["*"]);
    expect(extractCriticalLiterals("Use + then *").operators).toEqual(["+", "*"]);
    expect(extractCriticalLiterals("Use * then +").operators).toEqual(["*", "+"]);
    expect(extractCriticalLiterals("Calculate 7*8").operators).toEqual([]);
    expect(extractCriticalLiterals("Calculate 50+1").operators).toEqual([]);
    expect(extractCriticalLiterals("Calculate 500+1").operators).toEqual([]);
    expect(extractCriticalLiterals("Calculate 12 - 4").operators).toEqual([]);
    expect(extractCriticalLiterals("Calculate 12-4").operators).toEqual([]);
    expect(extractCriticalLiterals("Calculate 12 ++ 4").operators).toEqual(["++"]);
    expect(criticalLiteralsCompatible("Calculate 7*8", "Calculate 50+1")).toBe(false);
    expect(criticalLiteralsCompatible("Calculate 50+1", "Calculate 500+1")).toBe(false);
    // Glued `12-4` still hides the operand after the operator from the number
    // scan, so spaced vs glued stays a miss (prefer FN). Infix `-` is not a
    // second reason: both operator lists are empty.
    expect(extractCriticalLiterals("Calculate 12-4").numbers).toEqual(["12"]);
    expect(criticalLiteralsCompatible("Calculate 12 - 4", "Calculate 12-4")).toBe(false);
    expect(criticalLiteralsCompatible("Calculate 12 ++ 4", "Calculate 12 + 4")).toBe(false);
  });

  it("builds an ordered action fingerprint only for sequence-bearing instructions", () => {
    expect(extractCriticalLiterals("Roll back the deploy first, then drain nodes").order).toEqual(["roll", "back", "deploy", "drain", "nodes"]);
    expect(extractCriticalLiterals("Drain nodes first, then roll back the deploy").order).toEqual(["drain", "nodes", "roll", "back", "deploy"]);
    expect(extractCriticalLiterals("Backup database before truncate").order).toEqual(["backup", "database", "truncate"]);
    expect(extractCriticalLiterals("Truncate database before backup").order).toEqual(["truncate", "database", "backup"]);
    // No marker => empty fingerprint, so ordinary paraphrase is unaffected.
    expect(extractCriticalLiterals("Summarize the architecture of this repository").order).toEqual([]);
    expect(extractCriticalLiterals("Write tests for the cache package").order).toEqual([]);
  });

  it("recognizes the documented sequence markers", () => {
    for (const marker of ["first", "then", "before", "after", "next", "finally", "prior", "followed"]) {
      expect(extractCriticalLiterals(`alpha ${marker} beta`).order, marker).toEqual(["alpha", "beta"]);
    }
    expect(extractCriticalLiterals("Back up the database first, then truncate the log.").order).toEqual(["back", "up", "database", "truncate", "log"]);
    expect(extractCriticalLiterals("First back up the database; afterwards truncate the log.").order).toEqual(["back", "up", "database", "truncate", "log"]);
  });

  it("does not read a sequence marker as a keyword value", () => {
    // "database first" is a clause boundary, not the value of "database".
    const literals = extractCriticalLiterals("Back up the database first, then truncate the log.");
    expect(literals.keywords).toEqual([]);
  });
});