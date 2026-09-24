import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  canonicalInput,
  intentHash,
  normalizedHash,
  normalizeTask,
  normalizedKey,
  promptFingerprint,
  sha256
} from "@grokmax/core";

describe("sha256", () => {
  it("produces 64 lowercase hex chars", () => {
    const h = sha256("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256("x")).toBe(sha256("x"));
    expect(sha256("x")).not.toBe(sha256("X"));
  });
});

describe("versioned hashes", () => {
  it("canonicalHash version-pins", () => {
    expect(canonicalHash("abc")).toBe(canonicalHash("abc"));
  });

  it("canonicalHash and normalizedHash differ for the same raw text", () => {
    // canonical operates over canonicalInput, normalized over normalizedKey(shard-level)
    const task = { intent: "fix bugs", goal: "ship it" };
    expect(canonicalHash(canonicalInput(task))).not.toBe(normalizedHash(normalizedKey(normalizeTask(task))));
  });

  it("intentHash differs across intents", () => {
    expect(intentHash("write a test")).not.toBe(intentHash("write a readme"));
  });

  it("promptFingerprint includes context refs", () => {
    expect(promptFingerprint("task")).not.toBe(promptFingerprint("task", ["a.ts"]));
    expect(promptFingerprint("task", ["a.ts"])).toBe(promptFingerprint("task", ["a.ts"]));
  });
});