import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicProvider, evaluate, createDefaultRegistry, ChatGPTProvider, GrokBotProvider, OpenCodeProvider, ApiProvider } from "@grokmax/adapters";
import { SimpleRegistry } from "@grokmax/providers";
import type { CompiledPrompt, GrokMaxTask } from "@grokmax/core";

const prompt: CompiledPrompt = {
  prompt: "GOAL: x",
  inputChars: 0,
  outputChars: 0,
  tokensEstimate: 0,
  preserved: [],
  removed: [],
  validation: { ok: true, issues: [], preservedConstraints: [], lostConstraints: [] },
  stages: []
};

const run = (task: GrokMaxTask) => new DeterministicProvider().execute(prompt, task);
const mathTask = (s: string): GrokMaxTask => ({ intent: s, goal: s });

describe("evaluate (safe arithmetic)", () => {
  it("evaluates basic arithmetic", () => {
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("(2+3)*4")).toBe(20);
    expect(evaluate("10/4")).toBe(2.5);
    expect(evaluate("2^8")).toBe(256);
    expect(evaluate("7%3")).toBe(1);
    expect(evaluate("sqrt(16)")).toBe(4);
    expect(evaluate("abs(-5)")).toBe(5);
  });

  it("rejects malformed input", () => {
    expect(evaluate("2 + hello")).toBeNull();
    expect(evaluate("")).toBeNull();
    expect(evaluate("1/0")).toBeNull(); // divide by zero
    expect(evaluate("2 +")).toBeNull();
  });
});

describe("DeterministicProvider", () => {
  it("resolves math locally", async () => {
    const r = await run(mathTask("Calculate 7*8"));
    expect(r.status).toBe("success");
    expect(r.executor).toBe("deterministic");
    expect(r.summary).toContain("56");
    expect(r.costUsd).toBe(0);
  });

  it("resolves function math and nested/prefixed expressions", async () => {
    const sqrt = await run(mathTask("Calculate sqrt(144)"));
    expect(sqrt.summary).toContain("12");
    const abs = await run(mathTask("Calculate abs(-42)"));
    expect(abs.summary).toContain("42");
    const nested = await run(mathTask("Evaluate ((1+2)*(3+4))"));
    expect(nested.summary).toContain("21");
    const neg = await run(mathTask("Evaluate -5+3"));
    expect(neg.summary).toContain("-2");
  });

  it("does not resolve prose containing stray digits", async () => {
    const r = await run(mathTask("Fix the bug on page 42 and ship"));
    expect(r.status).toBe("failure");
    expect(r.summary).toContain("no deterministic");
  });

  it("throws meaningful summary when nothing matches", async () => {
    const r = await run(mathTask("Fix the scheduler bug and ship it"));
    expect(r.status).toBe("failure");
    expect(r.summary).toContain("no deterministic local resolver");
  });
});

describe("SimpleRegistry", () => {
  it("detects available providers without crashing", () => {
    const reg = new SimpleRegistry().add(new DeterministicProvider());
    expect(reg.detectSet().has("deterministic")).toBe(true);
  });

  it("falls back to deterministic when nothing detects", () => {
    const reg = new SimpleRegistry();
    expect(reg.detectSet().has("deterministic")).toBe(true);
  });

  it("gracefully fails when route unknown or provider offline", async () => {
    const reg = new SimpleRegistry().add(new DeterministicProvider());
    const missing = await reg.execute("opencode", prompt, mathTask("x"));
    expect(missing.status).toBe("failure");
    expect(missing.summary).toContain("no provider registered");
  });
});

describe("createDefaultRegistry composition", () => {
  it("constructs with opencode explicitly opted-in via detect override", () => {
    const reg = createDefaultRegistry({ opencode: {} });
    const set = reg.detectSet();
    // deterministic always present; others depend on environment
    expect(set.has("deterministic")).toBe(true);
    expect(set.has("api")).toBe(false); // no endpoint configured
  });
});

const fakeBins: string[] = [];

function fakeOpenCode(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "grokmax-opencode-"));
  fakeBins.push(dir);
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!${process.execPath}\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of fakeBins) rmSync(dir, { recursive: true, force: true });
  fakeBins.length = 0;
});

describe("OpenCodeProvider process status", () => {
  it("reports success when the process exits 0", async () => {
    const bin = fakeOpenCode(`process.stdout.write("opencode ok\\n"); process.exit(0);`);
    const r = await new OpenCodeProvider({ bin }).execute(prompt, mathTask("inspect the repo"));
    expect(r.status).toBe("success");
    expect(r.summary).toContain("opencode ok");
  });

  it("reports failure on a non-zero exit even when stdout is present", async () => {
    const bin = fakeOpenCode(`process.stdout.write("7*8 = 56\\n"); process.exit(7);`);
    const r = await new OpenCodeProvider({ bin }).execute(prompt, mathTask("inspect the repo"));
    expect(r.status).toBe("failure");
    expect(r.summary).toMatch(/exit|code 7|7/i);
    expect(r.evidence.join(" ")).not.toMatch(/completed/i);
  });

  it("does not treat a success JSON payload as success when the process exits non-zero", async () => {
    const bin = fakeOpenCode(
      `process.stdout.write(${JSON.stringify(JSON.stringify({ status: "success", message: "opencode completed" }))}); process.exit(7);`
    );
    const r = await new OpenCodeProvider({ bin }).execute(prompt, mathTask("inspect the repo"));
    expect(r.status).toBe("failure");
  });

  it("reports failure when the binary cannot be spawned", async () => {
    const r = await new OpenCodeProvider({ bin: join(tmpdir(), "grokmax-missing-opencode-bin") }).execute(prompt, mathTask("inspect the repo"));
    expect(r.status).toBe("failure");
    expect(r.summary).toMatch(/fail|error|spawn|enoent/i);
  });
});

describe("provider constructors require config", () => {
  it("OpenCodeProvider accepts explicit bin", () => {
    const p = new OpenCodeProvider({ bin: "definitely-not-installed" });
    expect(p.detect()).toBe(false);
  });
  it("ChatGPTProvider detects false without API key", () => {
    const p = new ChatGPTProvider({ apiKey: "" });
    expect(p.detect()).toBe(false);
  });
  it("GrokBotProvider detects false without bridge", () => {
    const p = new GrokBotProvider({ projectDir: "/nonexistent-bridge-xyz" });
    expect(p.detect()).toBe(false);
  });
  it("ApiProvider detects false without endpoint", () => {
    const p = new ApiProvider({ endpoint: "" });
    expect(p.detect()).toBe(false);
  });
});