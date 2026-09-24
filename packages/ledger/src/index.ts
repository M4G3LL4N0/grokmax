/**
 * Usage ledger.
 *
 * Records every run with an explicit distinction between MEASURED, ESTIMATED,
 * PROXY and UNKNOWN values. Never presents estimates as measurements.
 */
import type { SqliteStore } from "@grokmax/cache";
import type { LedgerEntry } from "@grokmax/core";

export type MeasurementKind = "measured" | "estimated" | "proxy" | "unknown";

export interface LedgerSummary {
  runs: number;
  successes: number;
  failures: number;
  cacheHits: number;
  grokbotUsed: number;
  grokbotAvoidedEstimate: number;
  measuredGrokbotAvoided: number;
  contextBeforeCharsTotal: number;
  contextAfterCharsTotal: number;
  elapsedMsTotal: number;
  estimatedUsdSpent: number;
  errors: number;
  retries: number;
}

export class Ledger {
  constructor(private readonly store: SqliteStore) {}

  record(entry: LedgerEntry): string {
    this.store.db
      .prepare("INSERT INTO ledger(run_id, payload, created_at) VALUES (?, ?, ?)")
      .run(entry.runId, JSON.stringify(entry), Date.now());
    return entry.runId;
  }

  get(runId: string): LedgerEntry | null {
    const row = this.store.db.prepare("SELECT payload FROM ledger WHERE run_id = ?").get(runId) as { payload: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload) as LedgerEntry;
  }

  list(limit = 50): LedgerEntry[] {
    const rows = this.store.db.prepare("SELECT payload FROM ledger ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as LedgerEntry);
  }

  updateMeasurements(runId: string, m: Partial<LedgerEntry["measured"]>): boolean {
    const entry = this.get(runId);
    if (!entry) return false;
    entry.measured = { ...entry.measured, ...m };
    this.store.db.prepare("UPDATE ledger SET payload = ? WHERE run_id = ?").run(JSON.stringify(entry), runId);
    return true;
  }

  count(): number {
    const row = this.store.db.prepare("SELECT COUNT(*) AS c FROM ledger").get() as { c: number };
    return Number(row.c);
  }

  summary(): LedgerSummary {
    const rows = this.store.db.prepare("SELECT payload FROM ledger").all() as Array<{ payload: string }>;
    const entries = rows.map((r) => JSON.parse(r.payload) as LedgerEntry);

    let cacheHits = 0;
    let grokbotUsed = 0;
    let measuredGrokbotAvoided = 0;
    let contextBeforeCharsTotal = 0;
    let contextAfterCharsTotal = 0;
    let elapsedMsTotal = 0;
    let estimatedUsdSpent = 0;
    let errors = 0;
    let retries = 0;

    for (const e of entries) {
      const cacheHit = e.cache.some((c) => c.hit && c.layer !== "L0");
      if (cacheHit) cacheHits += 1;
      if (e.route?.grokbotRequired) grokbotUsed += 1;
      if (e.measured.grokbotCalls != null) {
        if (e.measured.grokbotCalls === 0) measuredGrokbotAvoided += 1;
      } else if (!e.route?.grokbotRequired) {
        measuredGrokbotAvoided += 1; // only when route never required it (derived, proxy-ish)
      }
      if (e.context) {
        contextBeforeCharsTotal += e.context.contextBeforeChars;
        contextAfterCharsTotal += e.context.contextAfterChars;
      }
      elapsedMsTotal += e.elapsedMs;
      estimatedUsdSpent += e.route?.budget?.estimatedUsd ?? 0;
      errors += e.errors.length;
      retries += e.retries;
    }

    return {
      runs: entries.length,
      successes: entries.filter((e) => e.status === "success").length,
      failures: entries.filter((e) => e.status === "failure" || e.status === "blocked").length,
      cacheHits,
      grokbotUsed,
      grokbotAvoidedEstimate: entries.filter((e) => !e.route?.grokbotRequired).length,
      measuredGrokbotAvoided,
      contextBeforeCharsTotal,
      contextAfterCharsTotal,
      elapsedMsTotal,
      estimatedUsdSpent,
      errors,
      retries
    };
  }

  exports(): { raw: unknown[]; generatedAt: string; note: string } {
    return {
      raw: this.list(10000),
      generatedAt: new Date().toISOString(),
      note: "Values are labeled measured/estimated/proxy in each entry; estimates are never presented as measurements."
    };
  }
}

export function kindOf(field: string): MeasurementKind {
  switch (field) {
    case "providerCostUsd":
    case "accountUsageBefore":
    case "accountUsageAfter":
    case "grokbotCalls":
      return "measured";
    case "tokensEstimate":
    case "elapsedMs":
      return "estimated";
    case "contextBeforeChars":
    case "contextAfterChars":
      return "proxy";
    default:
      return "unknown";
  }
}