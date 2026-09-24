/**
 * Telemetry: cache stats, ledger summary, and honest savings computation.
 *
 * Honesty rules:
 *  - "savings" is only ever reported as avoided-GrokBot for tasks the router
 *    says WOULD have required GrokBot (proxy), or from manual measured import.
 *  - Measured rows, proxy rows, estimated rows and unknown rows NEVER share a
 *    single denominator in one report. `method` reflects what every counted
 *    row is: "measured" (all rows manually measured), "proxy" (all rows router
 *    estimates), or "mixed" (some measured, some not). Counts are always
 *    computed over the row set that matches the reported method.
 *  - We never claim to measure native GrokBot usage; the platform does not
 *    expose it. Manual/live measurement import is the only source for "measured".
 */
import type { GrokMaxCache } from "@grokmax/cache";
import type { Ledger } from "@grokmax/ledger";
import type { LedgerEntry } from "@grokmax/core";

export interface SavingsReport {
  generatedAt: string;
  method: "proxy" | "measured" | "mixed";
  eligibleTasks: number;
  tasksAvoidingGrokBot: number;
  tasksRequiringGrokBot: number;
  contextBeforeCharsMedian: number | null;
  contextAfterCharsMedian: number | null;
  contextReductionPctMedian: number | null;
  cacheHitRate: { hits: number; total: number; pct: number };
  caveats: string[];
}

export async function computeSavings(cache: GrokMaxCache, ledger: Ledger): Promise<SavingsReport> {
  const entries = ledger.list(10000);

  // A measured row has a real account/ledger reading; everything else is
  // router-derived. Counts are built over ONE row set so the report never
  // mixes measured and proxy denominators.
  const measuredRows = entries.filter((e) => e.measured.grokbotCalls != null);
  const proxyRows = entries.filter((e) => e.measured.grokbotCalls == null);
  const method: SavingsReport["method"] =
    measuredRows.length === 0 ? "proxy" : proxyRows.length === 0 ? "measured" : "mixed";
  const counted = method === "mixed" ? measuredRows : entries;

  const withContext = counted.filter((e) => e.context);
  const before = withContext.map((e) => e.context!.contextBeforeChars).sort((a, b) => a - b);
  const after = withContext.map((e) => e.context!.contextAfterChars).sort((a, b) => a - b);
  const reductionPct = withContext.map((e) => {
    const b = e.context!.contextBeforeChars;
    if (b === 0) return 0;
    return Math.round(((b - e.context!.contextAfterChars) / b) * 1000) / 10;
  });

  const hits = entries.filter((e) => e.cache.some((c) => c.hit && c.layer !== "L0")).length;

  const avoidedCount = counted.filter((e) => (e.measured.grokbotCalls != null ? e.measured.grokbotCalls === 0 : !e.route?.grokbotRequired)).length;

  return {
    generatedAt: new Date().toISOString(),
    method,
    eligibleTasks: counted.length,
    tasksAvoidingGrokBot: avoidedCount,
    tasksRequiringGrokBot: counted.length - avoidedCount,
    contextBeforeCharsMedian: median(before),
    contextAfterCharsMedian: median(after),
    contextReductionPctMedian: median(reductionPct),
    cacheHitRate: {
      hits,
      total: entries.length,
      pct: entries.length === 0 ? 0 : Math.round((hits / entries.length) * 1000) / 10
    },
    caveats: [
      "GrokBot platform usage is not directly observable; avoided-GrokBot counts are router-level proxies unless manually measured.",
      "Context reduction is a proxy for token cost, not a measurement of tokens billed.",
      ...(method === "mixed" ? ["Mixed report: counts reflect measured rows only; proxy rows were not folded into the denominator."] : [])
    ]
  };
}

export function savingsLine(r: SavingsReport): string {
  const pct = r.tasksAvoidingGrokBot > 0 ? Math.round((r.tasksAvoidingGrokBot / Math.max(1, r.eligibleTasks)) * 100) : 0;
  const basis = r.method === "measured" ? " (measured)" : r.method === "mixed" ? " (measured rows only)" : " (router estimate)";
  return `Across ${r.eligibleTasks} ranked run(s)${basis}, GrokMax routed ${r.tasksAvoidingGrokBot} task(s) (${pct}%) away from GrokBot; median context reduced from ${r.contextBeforeCharsMedian} to ${r.contextAfterCharsMedian} chars.`;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

export { type LedgerEntry };
export type { Ledger };