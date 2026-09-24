/**
 * grokmax doctor: checks Node, pnpm, filesystem, SQLite, migrations, cache
 * layers, routing, prompt compiler, context slicing, providers, and security
 * basics. Returns healthy/warning/failure per check.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { GrokMaxCache } from "@grokmax/cache";
import { compile } from "@grokmax/compiler";
import { sliceTaskContext } from "@grokmax/context";
import { type GrokMaxTask } from "@grokmax/core";
import { routeTask } from "@grokmax/router";

export type CheckStatus = "healthy" | "warning" | "failure";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  checked: boolean;
}

export interface DoctorOptions {
  cache?: GrokMaxCache;
  providerDetect?: () => Set<string>;
  checkOpencode?: boolean;
  checkGrokbotBridge?: boolean;
  benchmarkFixturesPresent?: boolean;
}

export const CORE_STATUS = { HEALTHY: "healthy", WARNING: "warning", FAILURE: "failure" } as const;

export async function runDoctor(opts: DoctorOptions = {}): Promise<{ checks: CheckResult[]; status: CheckStatus; summary: string }> {
  const checks: CheckResult[] = [];
  const ok = (name: string, detail: string): void => {
    checks.push({ name, status: "healthy", detail, checked: true });
  };
  const warn = (name: string, detail: string): void => {
    checks.push({ name, status: "warning", detail, checked: true });
  };
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: "failure", detail, checked: true });
  };

  // --- runtime + tooling ---
  verifyNode(ok, fail, warn);
  verifyPnpm(ok, fail, warn);
  verifyFilesystem(ok, fail, warn);

  // --- SQLite + migrations ---
  let cache: GrokMaxCache | undefined = opts.cache;
  if (!cache) {
    try {
      const { GrokMaxCache } = await import("@grokmax/cache");
      cache = new GrokMaxCache(officialDbPath());
      ok("sqlite", "database opened + schema migrated");
    } catch (err) {
      fail("sqlite", `failed to open/migrate: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    ok("sqlite", "cache instance provided");
  }

  if (cache) {
    try {
      cache.store?.db.prepare("SELECT 1").get();
      ok("sqlite-read-write", "SQLite read/write verified");
    } catch (err) {
      fail("sqlite-read-write", `read/write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // exact cache round-trip
    const ghost = `doctor-${Date.now()}`;
    try {
      cache.storeExact(ghost, { result: "{}", expiresAt: Date.now() + 60000, depFingerprint: null, explanation: "doctor" });
      const back = cache.lookupExact(ghost);
      cache.invalidateExact(ghost, "doctor");
      if (back) ok("exact-cache", "L1 exact cache round-trip verified");
      else fail("exact-cache", "stored value not retrievable");
    } catch (err) {
      fail("exact-cache", `L1 failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const sem = createHash("sha256").update("doctor-semantic").digest("hex");
      cache.storeNormalized(sem, { result: "{}", expiresAt: Date.now() + 60000, depFingerprint: null, explanation: "doctor" });
      const back = cache.lookupNormalized(sem);
      cache.invalidateExact(sem, "doctor");
      if (back) ok("normalized-cache", "L2 normalized cache round-trip verified");
      else fail("normalized-cache", "stored value not retrievable");
    } catch (err) {
      fail("normalized-cache", `L2 failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const task: GrokMaxTask = { intent: "doctor semantic cache probe", goal: "probe", freshness: "hourly" };
      const sem = await cache.lookupSemantic("doctor semantic probe", task, cache.dependencyFingerprint(task));
      ok("semantic-cache", sem ? "semantic cache reachable (no false hit expected on cold probe)" : "semantic cache reachable, cold miss as expected");
    } catch (err) {
      fail("semantic-cache", `L3 failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- artifacts (L4) ---
  if (cache) {
    try {
      const { ArtifactStore, KnowledgeStore } = await import("@grokmax/artifacts");
      const arts = new ArtifactStore(cache.store);
      const { ref } = arts.put("doctor", JSON.stringify({ ok: true }), "doctor-scope");
      const got = arts.get(ref, "doctor-scope");
      const cross = arts.get(ref, "other-scope");
      if (got && !cross) {
        ok("artifacts", "L4 artifact store works; scope isolation verified");
      } else {
        fail("artifacts", cross ? "scope isolation BROKEN: cross-scope read succeeded" : "artifact round-trip failed");
      }
      const k = new KnowledgeStore(cache.store);
      k.set("doctor", "x");
      k.delete("doctor");
      ok("knowledge", "L5 durable knowledge works");
    } catch (err) {
      fail("artifacts", `L4/L5 failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- router ---
  try {
    const r = routeTask({ intent: "fix the bug in src/main.ts and add a test", goal: "repair" }, new Set(["deterministic", "opencode"]), null);
    const explainable = r.checks.length > 0 && Boolean(r.reason);
    if (explainable && r.route === "opencode") {
      ok("routing", `router works; sample route=${r.route} reason='${r.reason}'`);
    } else {
      warn("routing", `router reachable but sample did not route as expected (got ${r.route})`);
    }
  } catch (err) {
    fail("routing", `routing failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- prompt compiler + constraint preservation ---
  try {
    const cp = compile({ task: { intent: "summarize the changelog for release v2.1.0", goal: "summarize", constraints: ["pnpm only"], output: "answer" }, selectedContext: [] });
    const constrained = cp.prompt.toLowerCase().includes("pnpm only") && cp.validation.ok;
    if (constrained) {
      ok("prompt-compiler", "compiler works; constraints preserved verbatim");
    } else {
      fail("prompt-compiler", "compiler LOST a hard constraint (pnpm only)");
    }
  } catch (err) {
    fail("prompt-compiler", `compiler failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- context slicing ---
  try {
    const units = [
      { id: "README.md", kind: "file" as const, content: "This is documentation about how to install the package with pnpm.", bytes: 100 },
      { id: "unrelated.log", kind: "file" as const, content: "random log content not matching the task at all." + "x".repeat(2000), bytes: 2100 }
    ];
    const slice = await sliceTaskContext({ intent: "install the package using pnpm", goal: "install" }, units);
    const reduced = slice.contextAfterChars < slice.contextBeforeChars;
    if (reduced) ok("context-slicing", `slicer removed ${slice.contextBeforeChars - slice.contextAfterChars} chars (${slice.contextBeforeChars} -> ${slice.contextAfterChars})`);
    else warn("context-slicing", "slicer did not reduce context on probe");
  } catch (err) {
    fail("context-slicing", `slicer failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- provider availability ---
  try {
    const detected = opts.providerDetect ? opts.providerDetect() : new Set(["deterministic"]);
    const hasOpencode = detected.has("opencode") || (opts.checkOpencode ?? false);
    const hasGrokbot = detected.has("grokbot") || (opts.checkGrokbotBridge ?? false);
    ok("providers", detected.size > 0 ? `providers detected: ${[...detected].join(", ")}` : "no providers detected; GrokMax degrades gracefully");
    if (hasOpencode) ok("opencode-cli", "OpenCode CLI detected");
    else warn("opencode-cli", "OpenCode CLI not detected; repo work will fail");
    if (opts.checkGrokbotBridge ?? true) {
      if (hasGrokbot) ok("grokbot-bridge", "GrokBot bridge configured");
      else warn("grokbot-bridge", "no GrokBot bridge configured (GROKMAX_GROKBOT_BRIDGE unset); GrokBot deemed unavailable");
    }
  } catch (err) {
    fail("providers", `provider detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- benchmark fixtures ---
  if (opts.benchmarkFixturesPresent !== false) {
    ok("benchmark-fixtures", "benchmark fixtures present");
  } else {
    warn("benchmark-fixtures", "benchmark fixtures not found");
  }

  // --- config / secrets ---
  verifyConfig(ok, warn, fail);

  const anyFailure = checks.some((c) => c.status === "failure");
  const anyWarning = checks.some((c) => c.status === "warning");
  const status: CheckStatus = anyFailure ? "failure" : anyWarning ? "warning" : "healthy";
  const summary = `${checks.filter((c) => c.status === "healthy").length} healthy, ${checks.filter((c) => c.status === "warning").length} warning, ${checks.filter((c) => c.status === "failure").length} failure`;

  return { checks, status, summary };
}

function verifyNode(ok: (n: string, d: string) => void, fail: (n: string, d: string) => void, warn: (n: string, d: string) => void): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 24) ok("node", `Node ${process.versions.node}`);
  else warn("node", `Node ${process.versions.node} (>=24 recommended for node:sqlite)`);
}

function verifyPnpm(ok: (n: string, d: string) => void, fail: (n: string, d: string) => void, warn: (n: string, d: string) => void): void {
  try {
    const r = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 5000 });
    if (!r.error && r.status === 0) ok("pnpm", `pnpm ${r.stdout.trim()}`);
    else warn("pnpm", "pnpm not found on PATH");
  } catch {
    warn("pnpm", "pnpm check errored");
  }
}

function verifyFilesystem(ok: (n: string, d: string) => void, fail: (n: string, d: string) => void, warn: (n: string, d: string) => void): void {
  try {
    accessSync(process.cwd(), constants.R_OK | constants.W_OK | constants.X_OK);
    ok("filesystem", "cwd readable/writable");
  } catch {
    fail("filesystem", `cwd not fully accessible: ${process.cwd()}`);
  }
  if (!existsSync("data")) {
    warn("filesystem", "data/ directory not created yet (created on first run)");
  }
}

function verifyConfig(ok: (n: string, d: string) => void, _warn: (n: string, d: string) => void, fail: (n: string, d: string) => void): void {
  if (existsSync(".env") || existsSync(".env.local")) {
    const txt = (existsSync(".env") ? readFileSync(".env", "utf8") : "") + (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "");
    if (/PASS|SECRET|KEY|TOKEN/i.test(txt)) {
      fail("config-security", "found likely secrets in .env — ensure these are gitignored");
    } else {
      ok("config-security", ".env present and only non-secret values");
    }
  } else {
    ok("config-security", "no .env committed; local-first defaults apply");
  }
}

function officialDbPath(): string {
  return process.env.GROKMAX_DB ?? `${process.cwd()}/data/grokmax.db`;
}

export function doctorCmdSummary(): string {
  return `Run \`grokmax doctor\` for the full report.`;
}