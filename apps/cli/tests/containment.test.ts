import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWithin } from "@grokmax/cache";
import { collectRawContext } from "../src/context.js";
import type { GrokMaxTask } from "@grokmax/core";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-context-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const task = (refs: string[]): GrokMaxTask => ({ intent: "i", goal: "g", contextRefs: refs });

describe("collectRawContext containment", () => {
  it("drops escaped refs instead of reading outside the workspace", () => {
    const base = freshDir();
    writeFileSync(join(base, "keep.txt"), "keep me");
    const units = collectRawContext(task(["../outside.txt", "/etc/passwd", "keep.txt"]), base);
    expect(units.map((u) => u.id)).toContain("keep.txt");
    expect(units.map((u) => u.id)).not.toContain("../outside.txt");
    expect(units.map((u) => u.id)).not.toContain("/etc/passwd");
    expect(units.some((u) => u.content.includes("keep me"))).toBe(true);
  });
});

describe("resolveWithin containment (shared util, asserted from the CLI plane)", () => {
  it("rejects traversal, absolute escapes and encoded traversal", () => {
    const base = freshDir();
    expect(resolveWithin("../etc", base)).toBeNull();
    expect(resolveWithin("/etc", base)).toBeNull();
    expect(resolveWithin("%2e%2e/etc", base)).toBeNull();
    expect(resolveWithin("a.txt", base)).toBe(join(base, "a.txt"));
  });
});