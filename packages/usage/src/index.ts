/**
 * Honest platform-usage snapshots.
 *
 * There is no Cursor/GrokBot billing API. Anything we know about platform
 * usage comes from an observation somebody actually made, usually by reading
 * a number off a screen. This module stores those observations with the
 * provenance that makes them auditable, and refuses to invent precision that
 * was never observed.
 *
 * Rules enforced here:
 *  - Every snapshot has a source, a capture method, and a measurement class.
 *  - A measurement class is never inferred from the shape of the data and is
 *    never upgraded. A `proxy` row stays a `proxy` forever.
 *  - A percentage is stored as a percentage. It is never back-solved into a
 *    fake token count, request count, or dollar amount.
 *  - A diff only ever compares snapshots that share a measurement class. If
 *    the classes differ the diff refuses and reports `unknown`, because the
 *    difference would be a category error rather than a measurement.
 */
import { createHash } from "node:crypto";
import type { SqliteStore } from "@grokmax/cache";

export const MEASUREMENT_CLASSES = ["measured_platform", "measured_ledger", "proxy", "estimated", "unknown"] as const;
export type MeasurementClass = (typeof MEASUREMENT_CLASSES)[number];

export const USAGE_SOURCES = ["cursor-ui", "grokbot-ui", "billing-page", "csv-export", "api", "manual", "unknown"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const CAPTURE_METHODS = ["manual", "browser-observed", "screenshot", "csv-import", "api-read", "derived", "unknown"] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

/**
 * The only quantity kinds a snapshot may carry. There is deliberately no
 * `tokens`, `requests`, or `dollars` derived from a percentage: if a number
 * was not displayed, it does not belong here.
 */
export const QUANTITY_KINDS = [
  "weeklyIncludedUsagePct",
  "weeklyLimitPct",
  "onDemandUsd",
  "onDemandMonthlyCapUsd",
  "grokbotCalls",
  "requests",
  "spendUsd"
] as const;
export type QuantityKind = (typeof QUANTITY_KINDS)[number];

/**
 * How precisely a quantity was actually observed. `displayed` means the UI
 * showed the figure and we recorded it. `range` means we only know a band
 * (e.g. "somewhere between 40% and 60%"). `unknown` means we have no value.
 * We never present a `range` as if it were an exact reading.
 */
export const PRECISIONS = ["displayed", "range", "derived", "unknown"] as const;
export type Precision = (typeof PRECISIONS)[number];

export interface UsageQuantity {
  kind: QuantityKind;
  value: number;
  unit: string;
  precision: Precision;
  /** Optional band for `precision: "range"` observations. */
  range?: { low: number; high: number };
  note?: string;
}

export interface UsageSnapshot {
  id: string;
  label: string;
  observedAt: string;
  createdAt: string;
  source: UsageSource;
  captureMethod: CaptureMethod;
  measurementClass: MeasurementClass;
  /** Overall precision of the weakest observation in the snapshot. */
  precision: Precision;
  sessionId: string | null;
  values: UsageQuantity[];
  notes: string | null;
}

export interface UsageSnapshotInput {
  label: string;
  observedAt?: string;
  source: UsageSource;
  captureMethod: CaptureMethod;
  measurementClass: MeasurementClass;
  values: UsageQuantity[];
  notes?: string;
  sessionId?: string;
  id?: string;
}

export interface SnapshotDiff {
  comparable: boolean;
  reason: string;
  measurementClass: MeasurementClass | "mixed";
  before: string | null;
  after: string | null;
  changes: Array<{
    kind: QuantityKind;
    before: number | null;
    after: number | null;
    delta: number | null;
    unit: string;
    precisionBefore: Precision | null;
    precisionAfter: Precision | null;
    /** True when the delta is a difference of displayed numbers. */
    measured: boolean;
  }>;
}

export class UsageSnapshotError extends Error {}

const PRECISION_RANK: Record<Precision, number> = { displayed: 3, derived: 2, range: 1, unknown: 0 };

export class UsageStore {
  constructor(private readonly store: SqliteStore) {}

  add(input: UsageSnapshotInput): UsageSnapshot {
    if (!input.label || !input.label.trim()) throw new UsageSnapshotError("snapshot label is required");
    if (!MEASUREMENT_CLASSES.includes(input.measurementClass)) throw new UsageSnapshotError(`unknown measurement class: ${String(input.measurementClass)}`);
    if (!USAGE_SOURCES.includes(input.source)) throw new UsageSnapshotError(`unknown usage source: ${String(input.source)}`);
    if (!CAPTURE_METHODS.includes(input.captureMethod)) throw new UsageSnapshotError(`unknown capture method: ${String(input.captureMethod)}`);
    if (!Array.isArray(input.values) || input.values.length === 0) throw new UsageSnapshotError("snapshot must record at least one observed quantity");

    for (const q of input.values) {
      if (!QUANTITY_KINDS.includes(q.kind)) throw new UsageSnapshotError(`unknown quantity kind: ${String(q.kind)}`);
      if (!Number.isFinite(q.value)) throw new UsageSnapshotError(`quantity ${q.kind} must be a finite number`);
      if (!PRECISIONS.includes(q.precision)) throw new UsageSnapshotError(`unknown precision for ${q.kind}: ${String(q.precision)}`);
      if (q.precision === "range" && !q.range) throw new UsageSnapshotError(`quantity ${q.kind} claims range precision but carries no range`);
      if (q.precision === "displayed" && q.range) throw new UsageSnapshotError(`quantity ${q.kind} is displayed but carries a range; that is a range observation`);
    }

    const seen = new Set<string>();
    for (const q of input.values) {
      if (seen.has(q.kind)) throw new UsageSnapshotError(`duplicate quantity kind: ${q.kind}`);
      seen.add(q.kind);
    }

    // A `displayed` percentage cannot be presented alongside a derived token
    // count for the same underlying quantity, because the second number was
    // never observed. We reject rather than silently drop.
    for (const q of input.values) {
      if (q.precision === "derived" && q.kind === "requests") {
        throw new UsageSnapshotError("derived request counts are not accepted; record only what the platform displayed");
      }
    }

    const observedAt = input.observedAt ?? new Date().toISOString();
    const createdAt = new Date().toISOString();
    const id = input.id ?? snapshotId(input.label, observedAt, input.measurementClass, input.values);
    const precision = weakestPrecision(input.values.map((q) => q.precision));

    const row: UsageSnapshot = {
      id,
      label: input.label.trim(),
      observedAt,
      createdAt,
      source: input.source,
      captureMethod: input.captureMethod,
      measurementClass: input.measurementClass,
      precision,
      sessionId: input.sessionId ?? null,
      values: input.values,
      notes: input.notes ?? null
    };

    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO usage_snapshots
         (id, label, observed_at, created_at, source, capture_method, measurement_class, precision, session_id, quantities, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.label,
        Date.parse(observedAt),
        Date.parse(createdAt),
        row.source,
        row.captureMethod,
        row.measurementClass,
        row.precision,
        row.sessionId,
        JSON.stringify(row.values),
        row.notes
      );

    return row;
  }

  get(id: string): UsageSnapshot | null {
    const row = this.store.db.prepare("SELECT * FROM usage_snapshots WHERE id = ?").get(id) as RawSnapshot | undefined;
    return row ? hydrate(row) : null;
  }

  findByLabel(label: string): UsageSnapshot | null {
    const row = this.store.db.prepare("SELECT * FROM usage_snapshots WHERE label = ? ORDER BY observed_at DESC LIMIT 1").get(label) as RawSnapshot | undefined;
    return row ? hydrate(row) : null;
  }

  list(limit = 50): UsageSnapshot[] {
    const rows = this.store.db.prepare("SELECT * FROM usage_snapshots ORDER BY observed_at DESC, created_at DESC LIMIT ?").all(limit) as unknown as RawSnapshot[];
    return rows.map(hydrate);
  }

  count(): number {
    const row = this.store.db.prepare("SELECT COUNT(*) AS c FROM usage_snapshots").get() as { c: number };
    return Number(row.c);
  }

  /**
   * Compare two snapshots. Refuses when the measurement classes differ, because
   * subtracting a `proxy` from a `measured_platform` produces a number that
   * means nothing.
   */
  diff(beforeId: string, afterId: string): SnapshotDiff {
    const before = this.get(beforeId);
    const after = this.get(afterId);
    if (!before || !after) {
      return {
        comparable: false,
        reason: !before && !after ? "neither snapshot exists" : `snapshot not found: ${!before ? beforeId : afterId}`,
        measurementClass: "unknown",
        before: before?.id ?? null,
        after: after?.id ?? null,
        changes: []
      };
    }

    if (before.measurementClass !== after.measurementClass) {
      return {
        comparable: false,
        reason: `measurement classes differ (${before.measurementClass} vs ${after.measurementClass}); a difference between classes is not a measurement`,
        measurementClass: "mixed",
        before: before.id,
        after: after.id,
        changes: []
      };
    }

    const kinds = new Set<QuantityKind>([...before.values.map((v) => v.kind), ...after.values.map((v) => v.kind)]);
    const changes: SnapshotDiff["changes"] = [];
    for (const kind of [...kinds].sort()) {
      const b = before.values.find((v) => v.kind === kind) ?? null;
      const a = after.values.find((v) => v.kind === kind) ?? null;
      const bothPresent = b != null && a != null;
      const comparable = bothPresent && b.precision !== "unknown" && a.precision !== "unknown";
      changes.push({
        kind,
        before: b?.value ?? null,
        after: a?.value ?? null,
        delta: comparable && bothPresent ? round(a.value - b.value) : null,
        unit: a?.unit ?? b?.unit ?? "",
        precisionBefore: b?.precision ?? null,
        precisionAfter: a?.precision ?? null,
        measured: comparable
      });
    }

    return {
      comparable: changes.some((c) => c.measured),
      reason:
        before.measurementClass === "measured_platform"
          ? "both snapshots are measured_platform observations of the same account"
          : `both snapshots are ${before.measurementClass}; treat the result as ${before.measurementClass}, not as platform billing`,
      measurementClass: before.measurementClass,
      before: before.id,
      after: after.id,
      changes
    };
  }
}

export function snapshotId(label: string, observedAt: string, cls: MeasurementClass, values: UsageQuantity[]): string {
  const payload = values.map((v) => `${v.kind}=${v.value}${v.precision === "range" && v.range ? `[${v.range.low}..${v.range.high}]` : ""}@${v.precision}`).join(",");
  return createHash("sha256").update(`${label}|${observedAt}|${cls}|${payload}`).digest("hex").slice(0, 16);
}

export function weakestPrecision(precisions: Precision[]): Precision {
  let weakest: Precision = "displayed";
  for (const p of precisions) if (PRECISION_RANK[p] < PRECISION_RANK[weakest]) weakest = p;
  return weakest;
}

/**
 * Only a before/after pair of `measured_platform` observations may be reported
 * as a platform usage reduction. Anything else reports `unknown` rather than a
 * fabricated number.
 */
export function platformUsageClaim(diff: SnapshotDiff): string {
  if (!diff.comparable) return "platform usage: unknown";
  if (diff.measurementClass !== "measured_platform") return "platform usage: unknown";
  const parts = diff.changes.filter((c) => c.measured).map((c) => `${c.kind} ${c.delta! > 0 ? "+" : ""}${c.delta}`);
  return `platform usage (measured_platform): ${parts.length > 0 ? parts.join(", ") : "no comparable change"}`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface RawSnapshot {
  id: string;
  label: string;
  observed_at: number;
  created_at: number;
  source: string;
  capture_method: string;
  measurement_class: string;
  precision: string;
  session_id: string | null;
  quantities: string;
  notes: string | null;
}

function hydrate(row: RawSnapshot): UsageSnapshot {
  return {
    id: row.id,
    label: row.label,
    observedAt: new Date(row.observed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    source: row.source as UsageSource,
    captureMethod: row.capture_method as CaptureMethod,
    measurementClass: row.measurement_class as MeasurementClass,
    precision: row.precision as Precision,
    sessionId: row.session_id,
    values: JSON.parse(row.quantities) as UsageQuantity[],
    notes: row.notes
  };
}
