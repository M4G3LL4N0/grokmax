import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "@grokmax/cache";
import { UsageStore, UsageSnapshotError, platformUsageClaim } from "@grokmax/usage";

let dirs: string[] = [];
function freshStore() {
  const d = mkdtempSync(join(tmpdir(), "grokmax-usage-"));
  dirs.push(d);
  return openStore(join(d, "t.db"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const base = {
  label: "weekly",
  source: "cursor-ui",
  captureMethod: "browser-observed",
  measurementClass: "measured_platform"
} as const;

describe("UsageStore provenance", () => {
  it("stores source, captureMethod and measurementClass on every snapshot", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const snap = usage.add({
      ...base,
      values: [{ kind: "weeklyIncludedUsagePct", value: 62, unit: "%", precision: "displayed" }]
    });
    expect(snap.source).toBe("cursor-ui");
    expect(snap.captureMethod).toBe("browser-observed");
    expect(snap.measurementClass).toBe("measured_platform");
    expect(usage.get(snap.id)?.measurementClass).toBe("measured_platform");
    s.close();
  });

  it("rejects an unknown measurement class instead of defaulting it", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    expect(() =>
      usage.add({
        ...base,
        measurementClass: "totally_measured" as never,
        values: [{ kind: "spendUsd", value: 1, unit: "usd", precision: "displayed" }]
      })
    ).toThrow(UsageSnapshotError);
    s.close();
  });

  it("rejects a snapshot with no observed quantities", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    expect(() => usage.add({ ...base, values: [] })).toThrow(UsageSnapshotError);
    s.close();
  });

  it("preserves coarse percentage precision exactly as observed", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const snap = usage.add({
      ...base,
      values: [{ kind: "weeklyIncludedUsagePct", value: 60, unit: "%", precision: "displayed", note: "UI showed 60% rounded" }]
    });
    expect(snap.values[0]!.value).toBe(60);
    expect(snap.values[0]!.precision).toBe("displayed");
    s.close();
  });

  it("stores a range observation as a range, not as a point", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const snap = usage.add({
      ...base,
      values: [{ kind: "weeklyIncludedUsagePct", value: 50, unit: "%", precision: "range", range: { low: 40, high: 60 } }]
    });
    expect(snap.values[0]!.precision).toBe("range");
    expect(snap.values[0]!.range).toEqual({ low: 40, high: 60 });
    s.close();
  });

  it("refuses a range claim with no range, and a displayed claim carrying a range", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    expect(() =>
      usage.add({ ...base, values: [{ kind: "spendUsd", value: 5, unit: "usd", precision: "range" }] })
    ).toThrow(/no range/);
    expect(() =>
      usage.add({
        ...base,
        values: [{ kind: "spendUsd", value: 5, unit: "usd", precision: "displayed", range: { low: 1, high: 9 } }]
      })
    ).toThrow(/range observation/);
    s.close();
  });

  it("rejects derived request counts — never invent numbers from percentages", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    expect(() =>
      usage.add({
        ...base,
        measurementClass: "estimated",
        values: [{ kind: "requests", value: 4200, unit: "requests", precision: "derived" }]
      })
    ).toThrow(/only what the platform displayed/);
    s.close();
  });

  it("rejects duplicate quantity kinds in one snapshot", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    expect(() =>
      usage.add({
        ...base,
        values: [
          { kind: "spendUsd", value: 1, unit: "usd", precision: "displayed" },
          { kind: "spendUsd", value: 2, unit: "usd", precision: "displayed" }
        ]
      })
    ).toThrow(/duplicate/);
    s.close();
  });

  it("reports the weakest precision across the snapshot", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const snap = usage.add({
      ...base,
      values: [
        { kind: "spendUsd", value: 1, unit: "usd", precision: "displayed" },
        { kind: "weeklyIncludedUsagePct", value: 60, unit: "%", precision: "range", range: { low: 55, high: 65 } }
      ]
    });
    expect(snap.precision).toBe("range");
    s.close();
  });
});

describe("UsageStore isolation between measurement classes", () => {
  it("refuses to diff snapshots from different measurement classes", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const measured = usage.add({
      ...base,
      label: "before",
      values: [{ kind: "spendUsd", value: 10, unit: "usd", precision: "displayed" }]
    });
    const proxy = usage.add({
      label: "before-proxy",
      source: "manual",
      captureMethod: "derived",
      measurementClass: "proxy",
      values: [{ kind: "spendUsd", value: 10, unit: "usd", precision: "derived" }]
    });
    const d = usage.diff(measured.id, proxy.id);
    expect(d.comparable).toBe(false);
    expect(d.measurementClass).toBe("mixed");
    expect(d.reason).toMatch(/difference between classes/);
    expect(platformUsageClaim(d)).toBe("platform usage: unknown");
    s.close();
  });

  it("diffs two measured_platform snapshots and reports a measured delta", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const before = usage.add({
      ...base,
      label: "week-1",
      values: [{ kind: "spendUsd", value: 10, unit: "usd", precision: "displayed" }]
    });
    const after = usage.add({
      ...base,
      label: "week-2",
      values: [{ kind: "spendUsd", value: 4, unit: "usd", precision: "displayed" }]
    });
    const d = usage.diff(before.id, after.id);
    expect(d.comparable).toBe(true);
    expect(d.changes[0]!.delta).toBe(-6);
    expect(d.changes[0]!.measured).toBe(true);
    expect(platformUsageClaim(d)).toContain("measured_platform");
    s.close();
  });

  it("never upgrades a proxy diff into a platform usage claim", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const a = usage.add({
      label: "p1",
      source: "manual",
      captureMethod: "derived",
      measurementClass: "proxy",
      values: [{ kind: "requests", value: 100, unit: "requests", precision: "displayed" }]
    });
    const b = usage.add({
      label: "p2",
      source: "manual",
      captureMethod: "derived",
      measurementClass: "proxy",
      values: [{ kind: "requests", value: 40, unit: "requests", precision: "displayed" }]
    });
    const d = usage.diff(a.id, b.id);
    expect(d.comparable).toBe(true);
    expect(platformUsageClaim(d)).toBe("platform usage: unknown");
    s.close();
  });

  it("refuses to diff two measured_ledger snapshots as platform usage", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const a = usage.add({
      label: "l1",
      source: "csv-export",
      captureMethod: "csv-import",
      measurementClass: "measured_ledger",
      values: [{ kind: "grokbotCalls", value: 30, unit: "calls", precision: "displayed" }]
    });
    const b = usage.add({
      label: "l2",
      source: "csv-export",
      captureMethod: "csv-import",
      measurementClass: "measured_ledger",
      values: [{ kind: "grokbotCalls", value: 12, unit: "calls", precision: "displayed" }]
    });
    const d = usage.diff(a.id, b.id);
    expect(d.changes[0]!.delta).toBe(-18);
    expect(platformUsageClaim(d)).toBe("platform usage: unknown");
    s.close();
  });

  it("reports unknown rather than guessing when a snapshot is missing", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    const a = usage.add({ ...base, values: [{ kind: "spendUsd", value: 1, unit: "usd", precision: "displayed" }] });
    const d = usage.diff(a.id, "does-not-exist");
    expect(d.comparable).toBe(false);
    expect(platformUsageClaim(d)).toBe("platform usage: unknown");
    s.close();
  });
});

describe("UsageStore listing", () => {
  it("lists snapshots newest-first and finds by label", () => {
    const s = freshStore();
    const usage = new UsageStore(s);
    usage.add({ ...base, label: "old", observedAt: "2024-01-01T00:00:00.000Z", values: [{ kind: "spendUsd", value: 1, unit: "usd", precision: "displayed" }] });
    usage.add({ ...base, label: "new", observedAt: "2024-02-01T00:00:00.000Z", values: [{ kind: "spendUsd", value: 2, unit: "usd", precision: "displayed" }] });
    expect(usage.list()[0]!.label).toBe("new");
    expect(usage.findByLabel("old")?.values[0]!.value).toBe(1);
    expect(usage.count()).toBe(2);
    s.close();
  });
});
