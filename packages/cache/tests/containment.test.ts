import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeDependencyFingerprint, resolveWithin } from "@grokmax/cache";
import type { GrokMaxTask } from "@grokmax/core";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "grokmax-contain-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const task = (refs: string[]): GrokMaxTask => ({ intent: "i", goal: "g", contextRefs: refs });

describe("resolveWithin containment", () => {
  it("resolves refs inside the base", () => {
    const base = freshDir();
    writeFileSync(join(base, "a.txt"), "a");
    expect(resolveWithin("a.txt", base)).toBe(join(base, "a.txt"));
    expect(resolveWithin("./a.txt", base)).toBe(join(base, "a.txt"));
    expect(resolveWithin(base, base)).toBe(base);
  });

  it("rejects traversal refs", () => {
    const base = freshDir();
    expect(resolveWithin("../etc", base)).toBeNull();
    expect(resolveWithin("../../etc", base)).toBeNull();
    expect(resolveWithin("/etc", base)).toBeNull();
  });

  it("rejects URL-encoded traversal", () => {
    const base = freshDir();
    expect(resolveWithin("%2e%2e/etc", base)).toBeNull();
    expect(resolveWithin("..%2fetc", base)).toBeNull();
  });

  it("rejects symlinks that escape the base", () => {
    const base = freshDir();
    symlinkSync("/etc/passwd", join(base, "evil"));
    expect(resolveWithin("evil", base)).toBeNull();
  });
});

describe("computeDependencyFingerprint containment", () => {
  it("does not hash files outside cwd and taints with a rejection marker", () => {
    const base = freshDir();
    const fp = computeDependencyFingerprint(task(["../../etc/passwd"]), { cwd: base });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).toBe(computeDependencyFingerprint(task(["../../etc/passwd"]), { cwd: base }));
    expect(fp).not.toBe(computeDependencyFingerprint(task(["a.txt"]), { cwd: base }));
  });

  it("hashes a contained absolute path under cwd", () => {
    const base = freshDir();
    writeFileSync(join(base, "b.txt"), "b");
    const fp = computeDependencyFingerprint(task([join(base, "b.txt")]), { cwd: base });
    expect(fp).toBeTruthy();
  });
});