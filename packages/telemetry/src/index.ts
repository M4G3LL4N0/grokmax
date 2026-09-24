/**
 * Telemetry: cache stats, ledger summary, and honest savings computation.
 *
 * Honesty rules:
 *  - "savings" is only ever reported as avoided-GrokBot for tasks the router
 *    says WOULD have required GrokBot (proxy), or from manual measured import.
 *  - We never claim to measure native GrokBot usage; the platform does not
 *    expose it. Manual/live measurement import is the only source for "measured".
 */
import type { GrokMaxCache } from "@grokmax/cache";
import type { Ledger } from "@grokmax/ledger";
import type { LedgerEntry } from "@grokmax/core";

export interface SavingsReport {
  generatedAt: string;
  method: "proxy" | "measured";
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
  const withContext = entries.filter((e) => e.context);
  const before = withContext.map((e) => e.context!.contextBeforeChars).sort((a, b) => a - b);
  const after = withContext.map((e) => e.context!.contextAfterChars).sort((a, b) => a - b);
  const reductionPct = withContext.map((e) => {
    const b = e.context!.contextBeforeChars;
    if (b === 0) return 0;
    return Math.round(((b - e.context!.contextAfterChars) / b) * 1000) / 10;
  });

  return {
    generatedAt: new Date().toISOString(),
    method: entries.some((e) => e.measured.grokbotCalls != null) ? "measured" : "proxy",
    eligibleTasks: entries.length,
    tasksAvoidingGrokBot: entries.filter((e) => !e.route?.grokbotRequired).length,
    tasksRequiringGrokBot: entries.filter((e) => e.route?.grokbotRequired).length,
    contextBeforeCharsMedian: median(before),
    contextAfterCharsMedian: median(after),
    contextReductionPctMedian: median(reductionPct),
    cacheHitRate: {
      hits: entries.filter((e) => e.cache.some((c) => c.hit && c.layer !== "L0")).length,
      total: entries.length,
      pct: entries.length === 0 ? 0 : Math.round((entries.filter((e) => e.cache.some((c) => c.hit && c.layer !== "L0")).length / entries.length) * 1000) / 10
    },
    caveats: [
      "GrokBot platform usage is not directly observable; avoided-GrokBot counts are router-level proxies unless manually measured.",
      "Context reduction is a proxy for token cost, not a measurement of tokens billed."
    ]
  };
}

export function savingsLine(r: SavingsReport): string {
  const pct = r.tasksAvoidingGrokBot > 0 ? Math.round((r.tasksAvoidingGrokBot / Math.max(1, r.eligibleTasks)) * 100) : 0;
  return `Across ${r.eligibleTasks} ranked run(s), GrokMax routed ${r.tasksAvoidingGrokBot} task(s) (${pct}%) away from GrokBot; median context reduced from ${r.contextBeforeCharsMedian} to ${r.contextAfterCharsMedian} chars.`;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

export { type LedgerEntry };
export type { Ledger };