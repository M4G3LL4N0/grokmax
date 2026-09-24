import { describe, expect, it } from "vitest";
import {
  canonicalInput,
  describeKey,
  normalizeTask,
  normalizeWhitespace,
  normalizedKey
} from "@grokmax/core";

const baseTask = {
  intent: "Fix the failing test in scheduling.ts",
  goal: "Make the CI pipeline green",
  constraints: ["pnpm only", "no new dependencies"],
  contextRefs: ["src/scheduling.ts", "tests/scheduling.test.ts"],
  freshness: "hourly" as const
};

describe("normalizeWhitespace", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeWhitespace("  fix   the  \n bug\t now  ")).toBe("fix the bug now");
  });
});

describe("normalizeTask", () => {
  it("normalizes whitespace on intent/goal", () => {
    const n = normalizeTask({ intent: "  Fix   the  bug\n", goal: "  make it   green  " });
    expect(n.intent).toBe("Fix the bug");
    expect(n.goal).toBe("make it green");
  });

  it("dedupes constraints and context refs", () => {
    const n = normalizeTask({ ...baseTask, constraints: ["pnpm only", "pnpm only", "  pnpm only  "], contextRefs: ["a.ts", "a.ts"] });
    expect(n.constraints).toEqual(["pnpm only"]);
    expect(n.contextRefs).toEqual(["a.ts"]);
  });

  it("applies default freshness when invalid/missing", () => {
    expect(normalizeTask({ intent: "x", goal: "y" }).freshness).toBe("hourly");
    // @ts-expect-error invalid freshness
    expect(normalizeTask({ intent: "x", goal: "y", freshness: "bogus" }).freshness).toBe("hourly");
  });

  it("captures every meaning-affecting dimension in the key", () => {
    const a = describeKey(normalizeTask({ ...baseTask, constraints: ["pnpm only"] }));
    const b = describeKey(normalizeTask({ ...baseTask, constraints: ["npm only"] }));
    expect(a).not.toBe(b);
  });

  it("treats different constraint orders as equivalent via normalizedKey", () => {
    const a = normalizedKey(normalizeTask({ ...baseTask, constraints: ["pnpm only", "no new"] }));
    const b = normalizedKey(normalizeTask({ ...baseTask, constraints: ["no new", "pnpm only"] }));
    expect(a).toBe(b);
  });
});

describe("canonicalInput", () => {
  it("is stable across runs", () => {
    const t = { intent: "Summarize release notes", goal: "Write a summary", freshness: "daily" as const };
    expect(canonicalInput(t)).toBe(canonicalInput(t));
  });

  it("changes when constraints change", () => {
    const a = canonicalInput({ intent: "x", goal: "y", constraints: ["pnpm only"] });
    const b = canonicalInput({ intent: "x", goal: "y", constraints: ["npm only"] });
    expect(a).not.toBe(b);
  });
});

describe("normalizedKey", () => {
  it("ignores case/whitespace on intent but keeps constraints", () => {
    const n1 = normalizeTask({ intent: "  Fix   Bugs ", goal: "token stream", constraints: ["pnpm only"] });
    const n2 = normalizeTask({ intent: "fix bugs", goal: "token stream", constraints: ["pnpm only"] });
    expect(normalizedKey(n1)).toBe(normalizedKey(n2));
    const n3 = normalizeTask({ intent: "fix bugs", goal: "token stream", constraints: ["yarn only"] });
    expect(normalizedKey(n1)).not.toBe(normalizedKey(n3));
  });
});