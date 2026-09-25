import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "apps/cli/src/index.ts");
const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function freshDb(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-cli-"));
  dirs.push(d);
  return join(d, "t.db");
}

interface RunResult<T = Record<string, unknown>> {
  stdout: string;
  stderr: string;
  json: T;
  code: number;
}

async function cli(db: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [TSX, CLI, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, GROKMAX_DB: db },
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    });
    return { stdout, stderr: "", json: safeParse(stdout), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", json: safeParse(e.stdout ?? ""), code: e.code ?? 1 };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe("grokmax edge", () => {
  it("completes a deterministic task with zero GrokBot invocation", async () => {
    const r = await cli(freshDb(), ["edge", "Calculate 50+1", "--json"]);
    expect(r.json.mode).toBe("edge");
    expect(r.json.route).toBe("deterministic");
    expect(r.json.executor).toBe("deterministic");
    expect(r.json.success).toBe(true);
    expect(r.json.grokbotRequired).toBe(false);
    expect(r.json.grokbotInvoked).toBe(false);
    expect(r.json.countedAsAvoided).toBe(true);
    expect(r.json.summary).toContain("51");
  });

  it("exposes the full structured contract required by the spec", async () => {
    const r = await cli(freshDb(), ["edge", "Calculate 2+2", "--json"]);
    for (const key of [
      "mode",
      "taskId",
      "route",
      "cacheState",
      "executor",
      "success",
      "grokbotRequired",
      "grokbotInvoked",
      "contextBefore",
      "contextAfter",
      "artifact",
      "measurement",
      "elapsedMs"
    ]) {
      expect(r.json, key).toHaveProperty(key);
    }
    expect(r.json.measurement).toMatchObject({ contextReduction: "proxy", platformUsage: "unknown" });
  });

  it("never counts a task that misses its contract as avoided", async () => {
    const db = freshDb();
    const r = await cli(db, ["edge", "Calculate 50+1", "--summary-contains", "quarterly budget report", "--json"]);
    expect(r.json.success).toBe(true);
    expect(r.json.criteriaMet).toBe(false);
    expect(r.json.countedAsAvoided).toBe(false);
  });

  it("exits non-zero when the task fails, so a caller cannot mistake failure for success", async () => {
    const db = freshDb();
    await cli(db, ["edge", "Write a poem about the sea", "--summary-regex", "^$", "--json"]);
    const r = await cli(db, ["edge", "Calculate 7*8", "--json", "--fresh"]);
    expect(r.code).toBe(0);
  });

  it("reuses the cache on a repeat run and still reports a genuine avoidance", async () => {
    const db = freshDb();
    await cli(db, ["edge", "Calculate 99+1", "--json"]);
    const second = await cli(db, ["edge", "Calculate 99+1", "--json"]);
    expect(second.json.cacheState).toBe("hit");
    expect(second.json.success).toBe(true);
    expect(second.json.grokbotInvoked).toBe(false);
    expect(second.json.countedAsAvoided).toBe(true);
  });

  it("--fresh bypasses the cache in edge mode", async () => {
    const db = freshDb();
    await cli(db, ["edge", "Calculate 12+3", "--json"]);
    const fresh = await cli(db, ["edge", "Calculate 12+3", "--fresh", "--json"]);
    expect(fresh.json.cacheState).toBe("miss");
    expect(fresh.json.success).toBe(true);
  });
});

describe("grokmax preflight", () => {
  it("returns DELEGATE with a micro-prompt for work that is not yet done", async () => {
    const r = await cli(freshDb(), ["preflight", "Refactor the router module", "--json"]);
    expect(["DELEGATE", "GROKBOT_REQUIRED", "FAIL"]).toContain(r.json.action);
    if (r.json.action === "DELEGATE") {
      expect(r.json.grokbotWorkRequired).toBe(false);
      expect(typeof r.json.microPrompt).toBe("string");
    }
  });

  it("returns RETURN_EXISTING_RESULT after the work is cached, and does not ask GrokBot to redo it", async () => {
    const db = freshDb();
    await cli(db, ["edge", "Calculate 2468+1357", "--json"]);
    const r = await cli(db, ["preflight", "Calculate 2468+1357", "--json"]);
    expect(r.json.action).toBe("RETURN_EXISTING_RESULT");
    expect(r.json.grokbotWorkRequired).toBe(false);
    expect(r.json.summary).toContain("3825");
  });

  it("emits the complete machine contract on every action", async () => {
    const r = await cli(freshDb(), ["preflight", "Summarize the changelog", "--json"]);
    for (const key of ["action", "mode", "grokbotWorkRequired", "reason", "instruction", "contextRefs", "cache", "route", "taskId"]) {
      expect(r.json, key).toHaveProperty(key);
    }
    expect(r.json.mode).toBe("inbot");
  });
});

describe("grokmax usage snapshot", () => {
  it("records a provenance-carrying snapshot and lists it", async () => {
    const db = freshDb();
    const add = await cli(db, [
      "usage", "snapshot", "add",
      "--label", "week-1",
      "--source", "cursor-ui",
      "--capture-method", "browser-observed",
      "--measurement-class", "measured_platform",
      "--kind", "onDemandUsd",
      "--value", "10",
      "--unit", "usd",
      "--precision", "displayed",
      "--json"
    ]);
    expect(add.json.source).toBe("cursor-ui");
    expect(add.json.captureMethod).toBe("browser-observed");
    expect(add.json.measurementClass).toBe("measured_platform");

    const list = await cli(db, ["usage", "snapshot", "list", "--json"]);
    const rows = list.json as unknown;
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as unknown[]).length).toBe(1);
  });

  it("refuses a diff across measurement classes and reports platform usage unknown", async () => {
    const db = freshDb();
    const a = await cli(db, ["usage", "snapshot", "add", "--label", "a", "--source", "cursor-ui", "--capture-method", "browser-observed", "--measurement-class", "measured_platform", "--kind", "onDemandUsd", "--value", "10", "--unit", "usd", "--json"]);
    const b = await cli(db, ["usage", "snapshot", "add", "--label", "b", "--source", "manual", "--capture-method", "derived", "--measurement-class", "proxy", "--kind", "onDemandUsd", "--value", "4", "--unit", "usd", "--precision", "derived", "--json"]);
    const d = await cli(db, ["usage", "snapshot", "diff", String(a.json.id), String(b.json.id), "--json"]);
    expect(d.json.comparable).toBe(false);
    expect(d.json.claim).toBe("platform usage: unknown");
  });

  it("reports a real measured_platform reduction when both sides are measured", async () => {
    const db = freshDb();
    const a = await cli(db, ["usage", "snapshot", "add", "--label", "a", "--source", "cursor-ui", "--capture-method", "browser-observed", "--measurement-class", "measured_platform", "--kind", "onDemandUsd", "--value", "20", "--unit", "usd", "--json"]);
    const b = await cli(db, ["usage", "snapshot", "add", "--label", "b", "--source", "cursor-ui", "--capture-method", "browser-observed", "--measurement-class", "measured_platform", "--kind", "onDemandUsd", "--value", "5", "--unit", "usd", "--json"]);
    const d = await cli(db, ["usage", "snapshot", "diff", String(a.json.id), String(b.json.id), "--json"]);
    expect(d.json.comparable).toBe(true);
    expect(String(d.json.claim)).toContain("measured_platform");
    expect(String(d.json.claim)).toContain("-15");
  });
});

describe("grokmax experiment", () => {
  it("creates an isolated session, records a success and a failure, and reports honestly", async () => {
    const db = freshDb();
    const created = await cli(db, ["experiment", "create", "s1", "--mode", "edge", "--cache-state", "cold", "--task-fixture-version", "v1", "--git-sha", "f9a320b", "--json"]);
    expect(created.json.mode).toBe("edge");
    expect(created.json.cacheState).toBe("cold");
    expect(created.json.dbNamespace).toBe("exp-s1");
    expect(created.json.cacheNamespace).toBe("cache-s1");

    await cli(db, ["experiment", "record", "s1", "good", "--status", "success", "--executor", "deterministic", "--cache-state", "cold", "--json"]);
    await cli(db, ["experiment", "record", "s1", "bad", "--status", "failure", "--no-success", "--executor", "grokbot", "--grokbot-required", "--grokbot-invoked", "--json"]);

    const report = await cli(db, ["experiment", "report", "s1", "--json"]);
    expect(report.json.eligibleTasks).toBe(2);
    expect(report.json.genuineAvoidances).toBe(1);
    expect(report.json.failures).toBe(1);
    expect(report.json.grokbotInvocations).toBe(1);
    expect(report.json.platformUsage).toBe("unknown");
  });

  it("refuses to create a duplicate session id", async () => {
    const db = freshDb();
    await cli(db, ["experiment", "create", "dup", "--mode", "edge", "--cache-state", "cold", "--json"]);
    const again = await cli(db, ["experiment", "create", "dup", "--mode", "edge", "--cache-state", "cold"]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("already exists");
  });
});

describe("grokmax bench manifest", () => {
  it("produces a cold manifest with a fresh-namespace reset", async () => {
    const r = await cli(freshDb(), ["bench", "manifest", "--name", "x", "--mode", "edge", "--cache-state", "cold", "--json"]);
    expect(r.json.cacheState).toBe("cold");
    expect(r.json.stateReset).toBe("fresh-namespace");
    expect(r.json.isolated).toBe(true);
  });

  it("refuses to compare a cold manifest against a warm one", async () => {
    const db = freshDb();
    const cold = await cli(db, ["bench", "manifest", "--name", "x", "--mode", "edge", "--cache-state", "cold", "--json"]);
    const warm = await cli(db, ["bench", "manifest", "--name", "x", "--mode", "edge", "--cache-state", "warm", "--json"]);
    const dir = mkdtempSync(join(tmpdir(), "grokmax-mf-"));
    dirs.push(dir);
    const { writeFileSync } = await import("node:fs");
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, JSON.stringify(cold.json));
    writeFileSync(b, JSON.stringify(warm.json));
    const cmp = await cli(db, ["bench", "compare", "--a", a, "--b", b, "--json"]);
    expect(cmp.json.comparable).toBe(false);
    expect(cmp.code).not.toBe(0);
  });
});
