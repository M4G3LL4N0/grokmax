import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeProvider, containedOrBase, runSpawn } from "@grokmax/adapters";
import type { CompiledPrompt, GrokMaxTask } from "@grokmax/core";

let dirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-opencode-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const prompt: CompiledPrompt = {
  prompt: "GOAL: fix the build",
  inputChars: 0,
  outputChars: 0,
  tokensEstimate: 0,
  preserved: [],
  removed: [],
  validation: { ok: true, issues: [], preservedConstraints: [], lostConstraints: [] },
  stages: []
};

function fakeBin(scenario: "ok" | "fail3" | "spew-success-but-fail"): string {
  const dir = freshDir();
  const bin = join(dir, "fake-opencode");
  let body = "#!/bin/sh\n";
  if (scenario === "ok") {
    body += `printf '%s' '{"status":"success","message":"all green"}'\nexit 0\n`;
  } else if (scenario === "fail3") {
    body += `printf '%s' 'working...' >&2\nexit 3\n`;
  } else {
    body += `printf '%s' 'success! everything passed'\nprintf '%s' 'real failure logged' >&2\nexit 1\n`;
  }
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return bin;
}

describe("runSpawn captures exit codes and signals", () => {
  it("resolves exit code 0 for a clean run", async () => {
    const r = await runSpawn("/bin/sh", ["-c", "echo hi"], { cwd: process.cwd(), timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("resolves non-zero exit code and stderr", async () => {
    const r = await runSpawn("/bin/sh", ["-c", "echo oops >&2; exit 7"], { cwd: process.cwd(), timeoutMs: 5000 });
    expect(r.exitCode).toBe(7);
    expect(r.stderr).toContain("oops");
  });

  it("reports signal termination", async () => {
    const r = await runSpawn("/bin/sh", ["-c", "kill -9 $$"], { cwd: process.cwd(), timeoutMs: 5000 });
    expect(r.signal).toBe("SIGKILL");
  });
});

describe("OpenCodeProvider / execute is exit-code aware", () => {
  it("returns success with parsed output and exit 0", async () => {
    const p = new OpenCodeProvider({ bin: fakeBin("ok") });
    const r = await p.execute(prompt, { intent: "x", goal: "y" });
    expect(r.status).toBe("success");
    expect(r.summary).toContain("all green");
    expect(r.exitCode).toBe(0);
  });

  it("returns failure with exit code 3 and captured stderr", async () => {
    const p = new OpenCodeProvider({ bin: fakeBin("fail3") });
    const r = await p.execute(prompt, { intent: "x", goal: "y" });
    expect(r.status).toBe("failure");
    expect(r.summary).toContain("code 3");
    expect(r.stderr).toContain("working...");
    expect(r.exitCode).toBe(3);
  });

  it("NEVER reports success when exit is 1 even if stdout says 'success'", async () => {
    const p = new OpenCodeProvider({ bin: fakeBin("spew-success-but-fail") });
    const r = await p.execute(prompt, { intent: "x", goal: "y" });
    expect(r.status).toBe("failure");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("real failure logged");
    expect(r.retryEligible).toBe(true);
  });

  it("aggregates stderr evidence on failure", async () => {
    const p = new OpenCodeProvider({ bin: fakeBin("fail3") });
    const r = await p.execute(prompt, { intent: "x", goal: "y" });
    expect(r.evidence.some((e) => e.includes("3"))).toBe(true);
  });
});

describe("OpenCodeProvider / availableCwd containment", () => {
  it("accepts an explicit projectDir override", () => {
    const p = new OpenCodeProvider({ projectDir: "/tmp" });
    expect(p.availableCwd({ intent: "x", goal: "y" })).toBe("/tmp");
  });

  it("sanitizes a traversal ref to the base directory", () => {
    const base = freshDir();
    const p = new OpenCodeProvider({ projectDir: base });
    const t: GrokMaxTask = { intent: "x", goal: "y", contextRefs: ["../../etc"] };
    expect(p.availableCwd(t)).toBe(base);
  });

  it("containedOrBase returns the ref when inside base, else the base", () => {
    const base = freshDir();
    expect(containedOrBase(".", base)).toBe(base);
    expect(containedOrBase("src", base)).toBe(join(base, "src"));
    expect(containedOrBase("../x", base)).toBe(base);
    expect(containedOrBase("/etc", base)).toBe(base);
  });
});