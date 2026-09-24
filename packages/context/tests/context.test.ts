import { describe, expect, it } from "vitest";
import { significantTokens, sliceTaskContext } from "@grokmax/context";
import type { ContextUnit } from "@grokmax/core";

const file = (id: string, content: string): ContextUnit => ({ id, kind: "file", content, bytes: Buffer.byteLength(content) });

describe("significantTokens", () => {
  it("drops stopwords, short tokens, numbers, dedupes", () => {
    expect(significantTokens("the and for fix bug bug 12345")).toEqual(["fix", "bug"]);
  });
});

describe("sliceTaskContext", () => {
  it("keeps referenced units regardless of score", async () => {
    const unit = file("src/main.ts", "completely unrelated noise".repeat(50));
    const slice = await sliceTaskContext({ intent: "fix bug in src/main.ts", goal: "repair", contextRefs: ["src/main.ts"] }, [unit]);
    expect(slice.selected).toHaveLength(1);
    expect(slice.selected[0]!.id).toBe("src/main.ts");
  });

  it("excludes irrelevant content and explains why", async () => {
    const relevant = file("docs.md", "explain the scheduler worker pool design");
    const noise = file("log.txt", "kafka partition offset replay message".repeat(200));
    const slice = await sliceTaskContext({ intent: "explain the scheduler worker pool design", goal: "explain" }, [relevant, noise]);
    expect(slice.selected.map((u) => u.id)).toContain("docs.md");
    expect(slice.excluded.map((u) => u.id)).toContain("log.txt");
    expect(slice.excludedReasons["log.txt"]).toMatch(/relevance|budget/);
    expect(slice.contextAfterChars).toBeLessThan(slice.contextBeforeChars);
  });

  it("respects the context budget", async () => {
    const units = Array.from({ length: 20 }, (_, i) => file(`f${i}`, `content matching task ${"x".repeat(500)}`));
    const slice = await sliceTaskContext({ intent: "task", goal: "goal" }, units, { maxContextChars: 2000 });
    expect(slice.contextAfterChars).toBeLessThanOrEqual(2000 + 500);
    expect(slice.contextAfterChars).toBeLessThan(slice.contextBeforeChars);
  });

  it("always keeps at least minKeep units", async () => {
    const units = [file("a.ts", "aaa"), file("b.ts", "bbb")];
    const slice = await sliceTaskContext({ intent: "zebra", goal: "giraffe" }, units, { maxContextChars: 10, minKeep: 1 });
    expect(slice.selected.length).toBeGreaterThanOrEqual(1);
  });

  it("required refs that exceed budget are excluded but recorded", async () => {
    const big = file("huge.txt", "x".repeat(10_000));
    const slice = await sliceTaskContext({ intent: "scan huge.txt", goal: "scan", contextRefs: ["huge.txt"] }, [big], { maxContextChars: 100 });
    expect(slice.excluded.map((u) => u.id)).toContain("huge.txt");
    expect(slice.excludedReasons["huge.txt"]).toContain("exceeds remaining budget");
  });

  it("reports byte and token estimates", async () => {
    const units = [file("a.ts", "fix this bug now".repeat(50))];
    const slice = await sliceTaskContext({ intent: "fix this bug now", goal: "fix" }, units);
    expect(slice.context_before_bytes).toBeGreaterThan(0);
    expect(slice.contextAfterChars).toBeGreaterThan(0);
    expect(slice.tokenEstimateAfter).toBe(Math.ceil(slice.contextAfterChars / 4));
  });
});