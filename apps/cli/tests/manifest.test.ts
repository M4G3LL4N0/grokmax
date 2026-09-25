import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManifestError, assertColdStateHonest, assertRepoFixtureSafe, buildManifest, compareManifests, describeManifest, namespaceFor } from "../src/manifest.js";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-manifest-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const base = {
  name: "live-v1",
  version: "v1.0.0",
  mode: "edge" as const,
  cacheState: "cold" as const,
  stateReset: "fresh-namespace" as const,
  taskFixtureVersion: "v1.0.0",
  repoFixtureVersion: null,
  repoFixturePath: null,
  gitSha: "f9a320b",
  capabilityClass: "deterministic" as const
};

describe("benchmark manifest isolation", () => {
  it("derives different cache namespaces for cold vs warm", () => {
    const cold = buildManifest(base);
    const warm = buildManifest({ ...base, cacheState: "warm", stateReset: "none" });
    expect(cold.cacheNamespace).not.toBe(warm.cacheNamespace);
  });

  it("derives different namespaces for different modes", () => {
    expect(buildManifest(base).cacheNamespace).not.toBe(buildManifest({ ...base, mode: "native" }).cacheNamespace);
    expect(buildManifest(base).cacheNamespace).not.toBe(buildManifest({ ...base, mode: "inbot" }).cacheNamespace);
  });

  it("derives the same namespace for identical inputs, so a re-run is reproducible", () => {
    expect(buildManifest(base).cacheNamespace).toBe(buildManifest({ ...base }).cacheNamespace);
  });

  it("marks cold and fresh-namespace runs as isolated", () => {
    expect(buildManifest(base).isolated).toBe(true);
    expect(buildManifest({ ...base, cacheState: "warm", stateReset: "none" }).isolated).toBe(false);
  });
});

describe("contamination guard", () => {
  it("REFUSES to compare a warm run against a cold run", () => {
    const cold = buildManifest(base);
    const warm = buildManifest({ ...base, cacheState: "warm", stateReset: "none" });
    const v = compareManifests(cold, warm);
    expect(v.comparable).toBe(false);
    expect(v.reason).toMatch(/not comparable/);
    expect(v.differences.join()).toMatch(/cache state/);
  });

  it("allows a mode comparison when everything else matches", () => {
    const a = buildManifest({ ...base, mode: "native" });
    const b = buildManifest({ ...base, mode: "edge" });
    const v = compareManifests(a, b);
    expect(v.comparable).toBe(true);
    expect(v.differences.join()).toMatch(/mode/);
  });

  it("refuses a comparison when task fixture versions differ", () => {
    const a = buildManifest({ ...base, mode: "native" });
    const b = buildManifest({ ...base, mode: "edge", taskFixtureVersion: "v2.0.0" });
    expect(compareManifests(a, b).comparable).toBe(false);
  });

  it("refuses a comparison when repo fixture versions differ", () => {
    const a = buildManifest({ ...base, mode: "native", repoFixtureVersion: "repo-v1" });
    const b = buildManifest({ ...base, mode: "edge", repoFixtureVersion: "repo-v2" });
    expect(compareManifests(a, b).comparable).toBe(false);
  });

  it("refuses a comparison when capability classes differ", () => {
    const a = buildManifest({ ...base, mode: "native", capabilityClass: "deterministic" });
    const b = buildManifest({ ...base, mode: "edge", capabilityClass: "browser" });
    expect(compareManifests(a, b).comparable).toBe(false);
  });
});

describe("cold-state honesty", () => {
  it("accepts a cold run that starts from a fresh namespace", () => {
    expect(() => assertColdStateHonest(buildManifest(base), false)).not.toThrow();
  });

  it("rejects a cold run whose namespace already exists", () => {
    expect(() => assertColdStateHonest(buildManifest(base), true)).toThrow(ManifestError);
    expect(() => assertColdStateHonest(buildManifest(base), true)).toThrow(/cold run must start from an empty namespace/);
  });

  it("rejects a cold run that did not declare a namespace reset", () => {
    const bad = buildManifest({ ...base, stateReset: "none" as never });
    expect(() => assertColdStateHonest(bad, false)).toThrow(/fresh-namespace/);
  });

  it("does not apply the cold check to a warm run", () => {
    const warm = buildManifest({ ...base, cacheState: "warm", stateReset: "none" });
    expect(() => assertColdStateHonest(warm, true)).not.toThrow();
  });
});

describe("repository fixture safety", () => {
  it("requires a repo fixture path for repository tasks", () => {
    const m = buildManifest({ ...base, capabilityClass: "repository" });
    expect(() => assertRepoFixtureSafe(m)).toThrow(/must set repoFixturePath/);
  });

  it("accepts an existing disposable fixture", () => {
    const d = freshDir();
    const fixture = join(d, "fixtures", "repo");
    mkdirSync(fixture, { recursive: true });
    const m = buildManifest({ ...base, capabilityClass: "repository", repoFixturePath: fixture });
    expect(() => assertRepoFixtureSafe(m)).not.toThrow();
  });

  it("rejects a missing fixture path", () => {
    const m = buildManifest({ ...base, capabilityClass: "repository", repoFixturePath: join(freshDir(), "nope") });
    expect(() => assertRepoFixtureSafe(m)).toThrow(/does not exist/);
  });

  it("rejects pointing at a live git worktree", () => {
    const d = freshDir();
    const live = join(d, "my-project");
    mkdirSync(join(live, ".git"), { recursive: true });
    const m = buildManifest({ ...base, capabilityClass: "repository", repoFixturePath: live });
    expect(() => assertRepoFixtureSafe(m)).toThrow(/live worktree is not allowed/);
  });

  it("accepts a disposable fixture that happens to be its own git repo", () => {
    const d = freshDir();
    const fixture = join(d, "benchmarks", "fixtures", "repo-min");
    mkdirSync(join(fixture, ".git"), { recursive: true });
    const m = buildManifest({ ...base, capabilityClass: "repository", repoFixturePath: fixture });
    expect(() => assertRepoFixtureSafe(m)).not.toThrow();
  });

  it("accepts a plain disposable fixture directory", () => {
    const d = freshDir();
    const fixture = join(d, "fixtures", "repo-min");
    mkdirSync(fixture, { recursive: true });
    const m = buildManifest({ ...base, capabilityClass: "repository", repoFixturePath: fixture });
    expect(() => assertRepoFixtureSafe(m)).not.toThrow();
  });

  it("does not apply the repository check to non-repository tasks", () => {
    expect(() => assertRepoFixtureSafe(buildManifest(base))).not.toThrow();
  });
});

describe("manifest rendering and namespace helper", () => {
  it("renders the fields an auditor needs", () => {
    const text = describeManifest(buildManifest(base));
    expect(text).toMatch(/mode:/);
    expect(text).toMatch(/cache state:/);
    expect(text).toMatch(/cache namespace:/);
    expect(text).toMatch(/isolated:/);
  });

  it("namespaceFor is stable for the same inputs", () => {
    expect(namespaceFor(base)).toBe(namespaceFor({ ...base }));
  });
});

describe("the live-v1 suite is well-formed and honest", () => {
  const suitePath = join(process.cwd(), "benchmarks", "live", "live-v1.json");

  it("has between 6 and 8 controlled scenarios", () => {
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as { scenarios: unknown[] };
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(6);
    expect(suite.scenarios.length).toBeLessThanOrEqual(8);
  });

  it("gives every scenario explicit success criteria", () => {
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as { scenarios: Array<{ id: string; successCriteria: Record<string, unknown> }> };
    for (const s of suite.scenarios) {
      expect(s.successCriteria, s.id).toBeTruthy();
      expect(s.successCriteria.completed, s.id).toBe(true);
    }
  });

  it("expects GrokBot for at most one scenario", () => {
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as { scenarios: Array<{ id: string; requiresGrokbot: boolean }> };
    const needs = suite.scenarios.filter((s) => s.requiresGrokbot);
    expect(needs.length).toBeLessThanOrEqual(1);
  });

  it("gives repository-modification scenarios a disposable fixture", () => {
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as { scenarios: Array<{ id: string; repoFixturePath?: string }> };
    for (const s of suite.scenarios.filter((x) => x.id.startsWith("repo-"))) {
      expect(s.repoFixturePath, s.id).toBeTruthy();
      expect(existsSync(join(process.cwd(), s.repoFixturePath as string)), s.id).toBe(true);
    }
  });

  it("the disposable fixture can be reset back to its declared contents", () => {
    const dir = join(process.cwd(), "benchmarks", "fixtures", "repo-min");
    const spec = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) as { files: Array<{ path: string; content: string }> };
    const target = join(dir, "fixtures", "TASK_NOTE.md");
    writeFileSync(target, "CONTAMINATED BY A PREVIOUS MODE", "utf8");
    expect(readFileSync(target, "utf8")).toBe("CONTAMINATED BY A PREVIOUS MODE");
    for (const f of spec.files) writeFileSync(join(dir, f.path), f.content, "utf8");
    expect(readFileSync(target, "utf8")).toBe(spec.files.find((f) => f.path === "fixtures/TASK_NOTE.md")!.content);
  });
});
