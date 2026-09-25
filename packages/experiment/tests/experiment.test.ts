import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "@grokmax/cache";
import { ExperimentError, ExperimentStore, cacheNamespaceFor, configFingerprintOf, dbNamespaceFor, evaluateCriteria, isGenuineAvoidance } from "@grokmax/experiment";

let dirs: string[] = [];
function freshStore() {
  const d = mkdtempSync(join(tmpdir(), "grokmax-exp-"));
  dirs.push(d);
  return openStore(join(d, "t.db"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeSession(s: ReturnType<typeof openStore>, over: Record<string, unknown> = {}) {
  return new ExperimentStore(s).create({
    id: "live-v020",
    mode: "edge",
    cacheState: "cold",
    taskFixtureVersion: "v1",
    repoFixtureVersion: "repo-v1",
    gitSha: "f9a320b",
    config: { semanticThreshold: 0.85 },
    ...over
  } as never);
}

describe("experiment session creation", () => {
  it("pins git SHA, fixture versions and a config fingerprint", () => {
    const s = freshStore();
    const sess = makeSession(s);
    expect(sess.gitSha).toBe("f9a320b");
    expect(sess.taskFixtureVersion).toBe("v1");
    expect(sess.repoFixtureVersion).toBe("repo-v1");
    expect(sess.configFingerprint).toMatch(/^[0-9a-f]{16}$/);
    s.close();
  });

  it("gives each session an isolated db and cache namespace", () => {
    const s = freshStore();
    const a = makeSession(s);
    const b = new ExperimentStore(s).create({ id: "other", mode: "native", cacheState: "warm", taskFixtureVersion: "v1" });
    expect(a.dbNamespace).not.toBe(b.dbNamespace);
    expect(a.cacheNamespace).not.toBe(b.cacheNamespace);
    expect(a.dbNamespace).toBe(dbNamespaceFor("live-v020"));
    expect(a.cacheNamespace).toBe(cacheNamespaceFor("live-v020"));
    s.close();
  });

  it("rejects an unknown mode and an unknown cache state", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    expect(() => e.create({ id: "x", mode: "quantum" as never, cacheState: "cold", taskFixtureVersion: "v1" })).toThrow(ExperimentError);
    expect(() => e.create({ id: "x", mode: "edge", cacheState: "lukewarm" as never, taskFixtureVersion: "v1" })).toThrow(ExperimentError);
    s.close();
  });

  it("refuses to create the same session id twice", () => {
    const s = freshStore();
    makeSession(s);
    expect(() => makeSession(s)).toThrow(/already exists/);
    s.close();
  });

  it("produces a stable config fingerprint regardless of key order", () => {
    expect(configFingerprintOf({ a: 1, b: 2 })).toBe(configFingerprintOf({ b: 2, a: 1 }));
    expect(configFingerprintOf({ a: 1 })).not.toBe(configFingerprintOf({ a: 2 }));
  });
});

describe("experiment records and cold/warm separation", () => {
  it("stores a record with its own cache state so a warm run cannot masquerade as cold", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    const sess = e.create({ id: "native-warm", mode: "native", cacheState: "warm", taskFixtureVersion: "v1" });
    e.record(sess.id, {
      taskId: "t1",
      status: "success",
      success: true,
      grokbotRequired: false,
      grokbotInvoked: false,
      cacheState: "warm",
      cacheLayer: "L1",
      executor: "deterministic",
      elapsedMs: 3
    });
    const recs = e.records(sess.id);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.cacheState).toBe("warm");
    expect(recs[0]!.cacheLayer).toBe("L1");
    expect(recs[0]!.mode).toBe("native");
    s.close();
  });

  it("keeps two modes in separate sessions with separate records", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    const edge = e.create({ id: "edge-cold", mode: "edge", cacheState: "cold", taskFixtureVersion: "v1" });
    const native = e.create({ id: "native-warm", mode: "native", cacheState: "warm", taskFixtureVersion: "v1" });
    for (const [sess, state] of [[edge, "cold"], [native, "warm"]] as const) {
      e.record(sess.id, { taskId: "t1", status: "success", success: true, grokbotRequired: false, grokbotInvoked: false, cacheState: state, elapsedMs: 1 });
    }
    expect(e.records(edge.id)[0]!.mode).toBe("edge");
    expect(e.records(native.id)[0]!.mode).toBe("native");
    expect(e.records(edge.id)[0]!.cacheState).not.toBe(e.records(native.id)[0]!.cacheState);
    s.close();
  });

  it("refuses to record into a closed session", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    e.create({ id: "done", mode: "edge", cacheState: "cold", taskFixtureVersion: "v1" });
    e.close("done");
    expect(() => e.record("done", { taskId: "t", status: "success", success: true, grokbotRequired: false, grokbotInvoked: false, cacheState: "cold", elapsedMs: 1 })).toThrow(/closed/);
    s.close();
  });
});

describe("measurement integrity: failed work is not savings", () => {
  it("does not count a failed task as avoided", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    const sess = e.create({ id: "f", mode: "edge", cacheState: "cold", taskFixtureVersion: "v1" });
    e.record(sess.id, { taskId: "bad", status: "failure", success: false, grokbotRequired: false, grokbotInvoked: false, cacheState: "cold", elapsedMs: 5 });
    e.record(sess.id, { taskId: "good", status: "success", success: true, grokbotRequired: false, grokbotInvoked: false, cacheState: "cold", elapsedMs: 5 });
    expect(e.avoidedCount(sess.id)).toBe(1);
    expect(e.eligibleCount(sess.id)).toBe(2);
    s.close();
  });

  it("does not count a task that invoked GrokBot as avoided", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    const sess = e.create({ id: "g", mode: "edge", cacheState: "cold", taskFixtureVersion: "v1", criteria: { noGrokbotInvocation: false } });
    e.record(sess.id, { taskId: "used", status: "success", success: true, grokbotRequired: true, grokbotInvoked: true, cacheState: "cold", elapsedMs: 5 });
    expect(e.avoidedCount(sess.id)).toBe(0);
    s.close();
  });

  it("enforces per-session success criteria such as an expected executor", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    const sess = e.create({ id: "c", mode: "edge", cacheState: "cold", taskFixtureVersion: "v1", criteria: { expectedExecutor: "deterministic" } });
    e.record(sess.id, { taskId: "ok", status: "success", success: true, grokbotRequired: false, grokbotInvoked: false, cacheState: "cold", executor: "deterministic", elapsedMs: 1 });
    e.record(sess.id, { taskId: "wrong", status: "success", success: true, grokbotRequired: false, grokbotInvoked: false, cacheState: "cold", executor: "opencode", elapsedMs: 1 });
    const recs = e.records(sess.id);
    expect(recs.find((r) => r.taskId === "ok")!.criteriaMet).toBe(true);
    expect(recs.find((r) => r.taskId === "wrong")!.criteriaMet).toBe(false);
    expect(e.avoidedCount(sess.id)).toBe(1);
    s.close();
  });

  it("validates a summary regex criterion", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    const sess = e.create({ id: "r", mode: "edge", cacheState: "cold", taskFixtureVersion: "v1", criteria: { summaryRegex: "=\\s*51$" } });
    e.record(sess.id, { taskId: "t", status: "success", success: true, grokbotRequired: false, grokbotInvoked: false, cacheState: "cold", elapsedMs: 1, result: { summary: "50+1 = 51" } });
    expect(e.records(sess.id)[0]!.criteriaMet).toBe(true);
    s.close();
  });
});

describe("experiment snapshot linkage", () => {
  it("attaches before and after usage snapshot ids", () => {
    const s = freshStore();
    const e = new ExperimentStore(s);
    e.create({ id: "snap", mode: "native", cacheState: "cold", taskFixtureVersion: "v1" });
    e.attachSnapshot("snap", "before", "sn-before");
    e.attachSnapshot("snap", "after", "sn-after");
    const sess = e.get("snap")!;
    expect(sess.beforeSnapshotId).toBe("sn-before");
    expect(sess.afterSnapshotId).toBe("sn-after");
    s.close();
  });
});

describe("experiment helpers", () => {
  it("isGenuineAvoidance requires success, no invocation and met criteria", () => {
    const base = {
      sessionId: "s",
      taskId: "t",
      mode: "edge" as const,
      createdAt: "2024-01-01T00:00:00.000Z",
      route: "deterministic",
      executor: "deterministic",
      cacheLayer: null,
      status: "success",
      success: true,
      grokbotRequired: false,
      grokbotInvoked: false,
      cacheState: "cold" as const,
      contextBefore: 1,
      contextAfter: 1,
      externalCostUsd: 0,
      elapsedMs: 1,
      retries: 0,
      artifact: null,
      criteriaMet: true,
      result: {}
    };
    expect(isGenuineAvoidance(base)).toBe(true);
    expect(isGenuineAvoidance({ ...base, success: false })).toBe(false);
    expect(isGenuineAvoidance({ ...base, grokbotInvoked: true })).toBe(false);
    expect(isGenuineAvoidance({ ...base, criteriaMet: false })).toBe(false);
  });

  it("evaluateCriteria treats an invalid regex as unmet rather than crashing", () => {
    const rec = {
      sessionId: "s", taskId: "t", mode: "edge" as const, createdAt: "", route: null, executor: null,
      cacheLayer: null, status: "success", success: true, grokbotRequired: false, grokbotInvoked: false,
      cacheState: "cold" as const, contextBefore: null, contextAfter: null, externalCostUsd: null,
      elapsedMs: 0, retries: 0, artifact: null, criteriaMet: null, result: {}
    };
    expect(evaluateCriteria({ completed: true, noGrokbotInvocation: true, summaryRegex: "([bad" }, rec)).toBe(false);
  });
});
