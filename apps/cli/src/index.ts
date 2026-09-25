#!/usr/bin/env node
/**
 * GrokMax CLI.
 *
 * Minimize GrokBot usage while maximizing verified useful output.
 *
 *   grokmax optimize "<goal>"       full pipeline run, prints plan + outcome
 *   grokmax run <intent> <goal>     explicit run
 *   grokmax ask "<question>"        shorthand for intent=goal=question
 *   grokmax edge "<task>"           complete work before GrokBot (Edge Mode)
 *   grokmax preflight "<task>"      In-Bot preflight contract (for the GrokBot skill)
 *   grokmax route "<goal>"          routing decision only (no execution)
 *   grokmax dry-run "<goal>"        plan + outcome without executing
 *   grokmax explain <runId>         describe a completed run
 *   grokmax cache stats|prune|clear
 *   grokmax usage                   ledger summary
 *   grokmax usage snapshot ...      provenance-aware platform usage observations
 *   grokmax experiment ...          reproducible live experiment sessions
 *   grokmax savings                 honest savings report (proxy/measured)
 *   grokmax benchmark [suite...]    run benchmark suites against fixtures
 *   grokmax doctor                  health checks
 *   grokmax status                  overall system status
 */
import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GrokMaxCache } from "@grokmax/cache";
import { compile } from "@grokmax/compiler";
import { sliceTaskContext } from "@grokmax/context";
import {
  routeTask,
  type CostModel
} from "@grokmax/router";
import { Ledger } from "@grokmax/ledger";
import { ArtifactStore, KnowledgeStore } from "@grokmax/artifacts";
import type { ProviderRegistry } from "@grokmax/providers";
import { createDefaultRegistry } from "@grokmax/adapters";
import { GrokMaxEngine, canonicalHash, canonicalInput, type GrokMaxTask, type CompiledPrompt } from "@grokmax/core";
import { runDoctor } from "@grokmax/doctor";
import { computeSavings, savingsLine } from "@grokmax/telemetry";
import { buildEdgeResult, edgeAvoidanceSummary, formatEdgeResult, type EdgeCriteria } from "@grokmax/edge";
import { formatPreflight, preflight } from "@grokmax/inbot";
import { UsageStore, platformUsageClaim, type UsageQuantity } from "@grokmax/usage";
import { ExperimentStore } from "@grokmax/experiment";
import { collectRawContext } from "./context.js";
import { assertColdStateHonest, buildManifest, compareManifests, describeManifest, type BenchmarkManifest } from "./manifest.js";

interface CliFlags {
  cwd: string;
  fresh: boolean;
  dryRun: boolean;
  json: boolean;
}

function resolveFlags(opts: Record<string, unknown>): CliFlags {
  return {
    cwd: String(opts.cwd ?? process.cwd()),
    fresh: Boolean(opts.fresh),
    dryRun: Boolean(opts.dryRun),
    json: Boolean(opts.json)
  };
}

/** Commander accumulator for repeatable options (`--kind a --kind b`). */
function collect<T>(map: (raw: string) => T = (raw) => raw as T): (value: string, previous: T[]) => T[] {
  return (value, previous) => [...(previous ?? []), map(value)];
}

function flagsOf(opts: Record<string, unknown>): CliFlags {
  return resolveFlags(opts);
}

/**
 * Read the CLI version from its own package.json so `grokmax --version` cannot
 * drift away from the published package version again.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function openCache(flags: CliFlags): GrokMaxCache {
  return new GrokMaxCache(process.env.GROKMAX_DB, { cwd: flags.cwd });
}

function buildEngine(cache: GrokMaxCache, _flags: CliFlags): GrokMaxEngine {
  const registry: ProviderRegistry = createDefaultRegistry();
  const detect = (): Set<string> => {
    try {
      const s = registry.detectSet();
      return s.size > 0 ? s : new Set(["deterministic"]);
    } catch {
      return new Set(["deterministic"]);
    }
  };
  const ledger = new Ledger(cache.store);
  const artifacts = new ArtifactStore(cache.store);
  const knowledge = new KnowledgeStore(cache.store);

  const deps = {
    cache,
    router: {
      route: (task: GrokMaxTask, available: Set<string>, ctx: { beforeChars: number; afterChars: number } | null) =>
        routeTask(task, available, ctx, COST_MODEL)
    },
    compiler: {
      compile: (o: { task: GrokMaxTask; selectedContext: string[]; history?: string[] }): CompiledPrompt => compile(o)
    },
    context: {
      slice: (task: GrokMaxTask, units: Parameters<typeof sliceTaskContext>[1]) => sliceTaskContext(task, units)
    },
    providers: {
      detect,
      execute: (route: string, cp: CompiledPrompt, task: GrokMaxTask) => registry.execute(route, cp, task),
      estimateCost: (): { usd: number | null; grokbotUsage: number } => ({ usd: 0.001, grokbotUsage: 0 })
    },
    artifacts: {
      put: async (kind: string, data: string, scope: string, meta?: Record<string, unknown>) => {
        const r = artifacts.put(kind, data, scope, meta);
        return { ref: r.ref, id: r.id };
      },
      get: async (ref: string, scope: string) => {
        const r = artifacts.get(ref, scope);
        return r ? { id: r.id, kind: r.kind, data: r.data, meta: r.meta } : null;
      },
      list: async (scope: string) => {
        const items = artifacts.list(scope);
        return items.map((i) => ({ id: i.id, kind: i.kind, size: i.bytes, createdAt: new Date(i.createdAt).toISOString() }));
      }
    },
    knowledge: {
      get: (k: string) => knowledge.get(k),
      set: (k: string, d: string) => knowledge.set(k, d)
    },
    ledger: {
      record: (e: Parameters<Ledger["record"]>[0]) => ledger.record(e)
    },
    now: () => new Date()
  };

  return new GrokMaxEngine(deps);
}

const COST_MODEL: CostModel = {
  toks: { deterministic: 0, api: 1500, chatgpt: 3500, opencode: 12000, grokbot: 20000 },
  usdPer1k: { deterministic: 0, api: 0.01, chatgpt: 0.01, opencode: 0.02, grokbot: 0.05 }
};

function makeTask(intent: string, goal: string, flags: CliFlags, extra: Partial<GrokMaxTask> = {}): GrokMaxTask {
  const task: GrokMaxTask = {
    intent,
    goal,
    contextRefs: ["./"],
    freshness: flags.fresh ? "live" : "hourly",
    // --fresh must bypass every answer cache (L0-L4/L5). requireFresh is what
    // the pipeline consults; freshness:"live" alone still permits an exact hit.
    ...(flags.fresh ? { requireFresh: true } : {}),
    ...extra
  };
  // requireFresh skips L1/L2/L3 lookup and write so --fresh recomputes.
  if (flags.fresh) task.requireFresh = true;
  if (flags.dryRun) task.preferredExecutor = "auto";
  return task;
}

function printPlan(out: Awaited<ReturnType<GrokMaxEngine["run"]>>, flags: CliFlags): void {
  const summary = out.outcome.summary;
  const layer = out.cache.find((c) => c.hit)?.layer ?? "MISS";
  const route = String(out.route.route).toUpperCase();
  const risk = FRESHNESS_LABEL[out.task.freshness ?? "hourly"] ?? "hourly";
  if (flags.json) {
    const j = {
      plan: {
        route,
        routeReason: out.route.reason,
        cacheLayer: layer,
        grokbotRequired: out.route.grokbotRequired,
        freshness: risk,
        estimatedUsd: out.route.budget.estimatedUsd,
        cheaperThanDirect: out.route.cheaperThanDirect,
        cacheChecks: out.cache.map((c) => ({ layer: c.layer, hit: c.hit, reason: c.reason }))
      },
      outcome: summary,
      status: out.outcome.status
    };
    console.log(JSON.stringify(j, null, 2) ?? "");
    return;
  }
  console.log(box(`GrokMax Plan`));
  console.log(`  ROUTE      ${route}`);
  console.log(`    reason:  ${out.route.reason}`);
  console.log(`  CACHE      ${layer} ${layer === "MISS" ? "(miss)" : "hit"}`);
  for (const c of out.cache.slice(1)) {
    if (c.hit) console.log(`    ${c.layer} hit — ${c.reason}`);
    else if (c.layer === "L1" || c.layer === "L2" || c.layer === "L3" || c.layer === "L4") console.log(`    ${c.layer} miss — ${c.reason}`);
  }
  console.log(`  GROKBOT    ${out.route.grokbotRequired ? "REQUIRED" : "not required"}`);
  console.log(`  FRESHNESS  ${risk}`);
  console.log(`  COST       ${out.route.budget.estimatedUsd == null ? "n/a" : `$${out.route.budget.estimatedUsd.toFixed(4)} est.`} (cheaper-than-direct: ${out.route.cheaperThanDirect ? "yes" : "no"})`);
  console.log();
  console.log(`OUTCOME ${out.outcome.status.toUpperCase()}`);
  console.log(summary);
  if (out.outcome.artifact) console.log(`ARTIFACT ${out.outcome.artifact}`);
  if (out.outcome.evidence.length > 0) {
    console.log();
    console.log("EVIDENCE");
    for (const e of out.outcome.evidence) console.log(`  - ${e}`);
  }
}

function box(text: string): string {
  const ruler = "─".repeat(Math.max(20, text.length + 2));
  return `┌${ruler}┐\n│ ${text} │\n└${ruler}┘`;
}

/**
 * Look for a previously completed result that the In-Bot preflight can hand
 * straight back. Only a successful worker result qualifies: a cached failure
 * is not an answer, and reusing it would tell the caller "already done" for
 * work that never actually succeeded.
 */
async function findExistingResult(
  cache: GrokMaxCache,
  task: GrokMaxTask,
  cacheChecks: Array<{ layer: string; hit: boolean; reason: string }>
): Promise<{ summary: string; artifact?: string | null; status: string } | null> {
  const hit = cacheChecks.find((c) => c.hit);
  if (!hit) return null;
  // A dry run reports cache state without returning the cached value, so ask
  // the cache directly for the exact entry the lookup already found, using the
  // engine's own canonical key.
  const exact = cache.lookupExact(canonicalHash(canonicalInput(task)));
  if (exact) {
    const parsed = safeWorkerResult(exact.result);
    if (parsed && parsed.status === "success") return { summary: parsed.summary, artifact: parsed.artifact ?? null, status: parsed.status };
  }
  return null;
}

function safeWorkerResult(raw: string): { status: string; summary: string; artifact?: string } | null {
  try {
    const v = JSON.parse(raw) as { status?: string; summary?: string; artifact?: string };
    if (typeof v.status === "string" && typeof v.summary === "string") return { status: v.status, summary: v.summary, artifact: v.artifact };
    return null;
  } catch {
    return null;
  }
}

const FRESHNESS_LABEL: Record<string, string> = {
  immutable: "immutable (no expiry)",
  slow: "7-day expiry",
  daily: "24h expiry",
  hourly: "1h expiry",
  live: "5m expiry",
  "never-cache": "never cached"
};

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("grokmax")
    .description("Minimize GrokBot usage while maximizing verified useful output.")
    .version(readPackageVersion())
    .option("--cwd <path>", "working directory", process.cwd());

  program
    .command("optimize <goal>")
    .description("Run the full pipeline on a goal and print the plan + outcome.")
    .option("--fresh", "bypass cache and recompute")
    .option("--json", "emit JSON")
    .action(async (goal: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const engine = buildEngine(cache, flags);
        const rawContext = collectRawContext(makeTask(goal, goal, flags), flags.cwd);
        const out = await engine.run(makeTask(goal, goal, flags), { rawContext });
        printPlan(out, flags);
      } finally {
        cache.close();
      }
    });

  program
    .command("run <intent> <goal>")
    .description("Run an explicit intent + goal.")
    .option("--fresh", "bypass cache and recompute")
    .option("--json", "emit JSON")
    .action(async (intent: string, goal: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const engine = buildEngine(cache, flags);
        const rawContext = collectRawContext(makeTask(intent, goal, flags), flags.cwd);
        const out = await engine.run(makeTask(intent, goal, flags), { rawContext });
        printPlan(out, flags);
      } finally {
        cache.close();
      }
    });

  program
    .command("ask <question>")
    .description("Shorthand: intent=goal=question, print the answer.")
    .option("--fresh", "bypass cache and recompute")
    .option("--json", "emit JSON")
    .action(async (question: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const engine = buildEngine(cache, flags);
        const rawContext = collectRawContext(makeTask(question, question, flags), flags.cwd);
        const out = await engine.run(makeTask(question, question, flags), { rawContext });
        console.log(out.outcome.summary);
      } finally {
        cache.close();
      }
    });

  program
    .command("edge <task>")
    .description("Edge Mode: complete the task with the real pipeline, reaching for GrokBot only when genuinely required.")
    .option("--fresh", "bypass cache and recompute")
    .option("--json", "emit JSON")
    .option("--summary-regex <re>", "contract: outcome summary must match this regex")
    .option("--summary-contains <text>", "contract: outcome summary must contain this text")
    .option("--min-evidence <n>", "contract: at least this many evidence items", (v) => Number(v))
    .option("--require-artifact", "contract: an artifact reference must be produced")
    .action(async (taskText: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const engine = buildEngine(cache, flags);
        const task = makeTask(taskText, taskText, flags);
        const rawContext = collectRawContext(task, flags.cwd);
        const out = await engine.run(task, { rawContext });
        const criteria: Partial<EdgeCriteria> = {};
        if (typeof opts.summaryRegex === "string") criteria.summaryRegex = opts.summaryRegex;
        if (typeof opts.summaryContains === "string") criteria.summaryContains = opts.summaryContains;
        if (typeof opts.minEvidence === "number") criteria.minEvidence = opts.minEvidence;
        if (opts.requireArtifact) criteria.requireArtifact = true;
        const result = buildEdgeResult({ task, run: out, criteria });
        if (flags.json) {
          // The summary line is only meaningful for this single run, so it is
          // reported as a one-task aggregate rather than a suite-level ratio.
          console.log(JSON.stringify({ ...result, summaryLine: edgeAvoidanceSummary([result]) }, null, 2));
        } else {
          console.log(formatEdgeResult(result));
        }
        if (!result.success) process.exitCode = 1;
      } finally {
        cache.close();
      }
    });

  program
    .command("preflight <task>")
    .description("In-Bot preflight: tell a GrokBot caller whether to reuse, delegate, or act.")
    .option("--mode <mode>", "execution mode", "inbot")
    .option("--mode-exec <mode>", "read the pre-existing result from a previous run (for cache-return tests)")
    .option("--json", "emit JSON")
    .action(async (taskText: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const engine = buildEngine(cache, flags);
        const task = makeTask(taskText, taskText, flags);
        // Preflight must not itself execute the work; it only decides.
        const dry = await engine.run(task, { dryRunOnly: true });
        const existing = await findExistingResult(cache, task, dry.cache);
        const decision = routeTask(task, new Set(createDefaultRegistry().detectSet()), null, COST_MODEL);
        const result = preflight({
          task,
          route: dry.route.route === "none" && decision.route !== "none" ? decision : dry.route,
          cache: dry.cache,
          existing,
          taskId: dry.run.runId
        });
        if (flags.json) console.log(JSON.stringify(result, null, 2));
        else console.log(formatPreflight(result));
        if (result.action === "FAIL") process.exitCode = 1;
      } finally {
        cache.close();
      }
    });

  program
    .command("route <goal>")
    .description("Show only the routing decision (never executes).")
    .option("--json", "emit JSON")
    .action((goal: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const registry: ProviderRegistry = createDefaultRegistry();
        const available = registry.detectSet();
        const task = makeTask(goal, goal, { ...flags, dryRun: true });
        const decision = routeTask(task, available, null, COST_MODEL);
        if (flags.json) {
          console.log(JSON.stringify(decision, null, 2));
        } else {
          console.log(`ROUTE  ${String(decision.route).toUpperCase()}`);
          console.log(`REASON ${decision.reason}`);
          console.log(`GROKBOT ${decision.grokbotRequired ? "REQUIRED" : "not required"}`);
          console.log(`AVAILABLE_PROVIDERS ${[...available].join(", ") || "(none)"}`);
        }
      } finally {
        cache.close();
      }
    });

  program
    .command("dry-run <goal>")
    .description("Compute the plan and outcome WITHOUT executing anything.")
    .option("--json", "emit JSON")
    .action(async (goal: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts, dryRun: true });
      const cache = openCache(flags);
      try {
        const engine = buildEngine(cache, flags);
        const rawContext = collectRawContext(makeTask(goal, goal, flags), flags.cwd);
        const out = await engine.run(makeTask(goal, goal, flags), { rawContext, dryRunOnly: true });
        printPlan(out, flags);
      } finally {
        cache.close();
      }
    });

  program
    .command("explain <runId>")
    .description("Explain a completed run from the ledger.")
    .option("--json", "emit JSON")
    .action((runId: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const ledger = new Ledger(cache.store);
        const e = ledger.get(runId);
        if (!e) {
          console.error(`No run '${runId}' in ledger.`);
          process.exitCode = 1;
          return;
        }
        if (flags.json) {
          console.log(JSON.stringify(e, null, 2));
        } else {
          console.log(box(`Run ${e.runId}`));
          console.log(`  goal:      ${e.goal}`);
          console.log(`  status:    ${e.status}`);
          console.log(`  route:     ${String(e.route?.route ?? "?").toUpperCase()}`);
          console.log(`  cache:     ${e.cache.map((c) => c.hit ? `${c.layer}(hit)` : `${c.layer}(miss)`).join(" ")}`);
          console.log(`  grokbot?   ${e.route?.grokbotRequired ? "yes" : "no"}`);
          console.log(`  elapsed:   ${e.elapsedMs}ms`);
          console.log(`  measured:  ${JSON.stringify(e.measured ?? {})}`);
          console.log(`  errors:    ${e.errors.length}`);
          if (e.context) {
            console.log(`  context:   ${e.context.contextBeforeChars} -> ${e.context.contextAfterChars} chars (${e.context.tokenEstimateBefore} -> ${e.context.tokenEstimateAfter} tok est)`);
          }
          console.log();
          console.log(e.worker?.summary ?? "(no worker)");
        }
      } finally {
        cache.close();
      }
    });

  program
    .command("cache <action>")
    .description("cache stats | prune | clear")
    .action((action: string) => {
      const flags = resolveFlags(program.opts());
      const cache = openCache(flags);
      try {
        switch (action) {
          case "stats": {
            const s = cache.stats();
            const ledger = new Ledger(cache.store);
            console.log(`exact hits:      ${s.exactHits}`);
            console.log(`exact misses:    ${s.exactMisses}`);
            console.log(`normalized hits: ${s.normalizedHits}`);
            console.log(`semantic hits:   ${s.semanticHits}`);
            console.log(`semantic misses: ${s.semanticMisses}`);
            console.log(`coalesced:       ${s.coalesced}`);
            console.log(`hot entries:     ${s.size}`);
            console.log(`ledger entries:  ${ledger.count()}`);
            const inv = cache.prune();
            console.log(`pruned:          ${inv.removed} expired (${inv.invalidations} invalidations) `);
            return;
          }
          case "prune": {
            const r = cache.prune();
            console.log(`pruned ${r.removed} expired entries; ${r.invalidations} total invalidations.`);
            return;
          }
          case "clear": {
            cache.clearAll();
            console.log("cleared all cache layers (exact, normalized, semantic, invalidations).");
            console.log("ledger preserved.");
            return;
          }
          default:
            console.error(`Unknown cache action: ${action} (stats|prune|clear)`);
            process.exitCode = 1;
        }
      } finally {
        cache.close();
      }
    });

  const usageCmd = program
    .command("usage")
    .description("Ledger summary, or `grokmax usage snapshot ...` for provenance-aware platform observations.")
    .action(() => {
      const flags = resolveFlags(program.opts());
      const cache = openCache(flags);
      try {
        const ledger = new Ledger(cache.store);
        const s = ledger.summary();
        console.log(box("GrokMax usage (labels are honest: measured/estimated/proxy)"));
        console.log(`  runs:                 ${s.runs}`);
        console.log(`  successes:            ${s.successes}`);
        console.log(`  failures:             ${s.failures}`);
        console.log(`  cache hits:           ${s.cacheHits}`);
        console.log(`  grokbot used:         ${s.grokbotUsed}`);
        console.log(`  grokbot-avoided (est): ${s.grokbotAvoidedEstimate}`);
        console.log(`  grokbot-avoided (measured): ${s.measuredGrokbotAvoided}`);
        console.log(`  context before (chars): ${s.contextBeforeCharsTotal}`);
        console.log(`  context after (chars):  ${s.contextAfterCharsTotal}`);
        console.log(`  elapsed total:        ${s.elapsedMsTotal}ms`);
        console.log(`  estimated usd spent:  ${s.estimatedUsdSpent.toFixed(4)}`);
      } finally {
        cache.close();
      }
    });

  const snapshot = usageCmd
    .command("snapshot")
    .description("Provenance-aware platform usage observations (there is no Cursor billing API).");

  snapshot
    .command("add")
    .description("Record an observed platform usage reading.")
    .requiredOption("--label <label>", "short label for this observation")
    .requiredOption("--source <source>", "cursor-ui | grokbot-ui | billing-page | csv-export | api | manual | unknown")
    .requiredOption("--capture-method <method>", "manual | browser-observed | screenshot | csv-import | api-read | derived | unknown")
    .requiredOption("--measurement-class <class>", "measured_platform | measured_ledger | proxy | estimated | unknown")
    .option("--kind <kind>", "quantity kind", collect<string>())
    .option("--value <n>", "numeric value", collect<number>((v) => Number(v)))
    .option("--unit <unit>", "unit label", collect<string>())
    .option("--precision <precision>", "displayed | range | derived | unknown", collect<string>())
    .option("--range-low <n>", "low bound for a range observation", (v) => Number(v))
    .option("--range-high <n>", "high bound for a range observation", (v) => Number(v))
    .option("--notes <text>", "free-form notes")
    .option("--json", "emit JSON")
    .action((opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const kinds = (opts.kind as string[]) ?? [];
        const values = (opts.value as number[]) ?? [];
        const units = (opts.unit as string[]) ?? [];
        const precisions = (opts.precision as string[]) ?? [];
        if (kinds.length !== values.length) {
          console.error("--kind and --value must be supplied the same number of times.");
          process.exitCode = 1;
          return;
        }
        const quantities: UsageQuantity[] = kinds.map((kind, i) => {
          const precision = (precisions[i] ?? "displayed") as UsageQuantity["precision"];
          const q: UsageQuantity = { kind: kind as UsageQuantity["kind"], value: values[i] as number, unit: units[i] ?? "", precision };
          if (typeof opts.rangeLow === "number" && typeof opts.rangeHigh === "number" && precision === "range") {
            q.range = { low: opts.rangeLow, high: opts.rangeHigh };
          }
          return q;
        });
        const usage = new UsageStore(cache.store);
        const snap = usage.add({
          label: String(opts.label),
          source: opts.source as never,
          captureMethod: opts.captureMethod as never,
          measurementClass: opts.measurementClass as never,
          values: quantities,
          notes: typeof opts.notes === "string" ? opts.notes : undefined
        });
        if (flags.json) console.log(JSON.stringify(snap, null, 2));
        else {
          console.log(`SNAPSHOT ${snap.id}  ${snap.label}`);
          console.log(`  observed:   ${snap.observedAt}`);
          console.log(`  source:     ${snap.source} / ${snap.captureMethod}`);
          console.log(`  class:      ${snap.measurementClass} (precision: ${snap.precision})`);
          for (const q of snap.values) console.log(`  - ${q.kind} = ${q.value}${q.unit}${q.range ? ` [${q.range.low}..${q.range.high}]` : ""} (${q.precision})`);
        }
      } finally {
        cache.close();
      }
    });

  snapshot
    .command("list")
    .description("List recorded platform usage observations.")
    .option("--json", "emit JSON")
    .action((opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const usage = new UsageStore(cache.store);
        const rows = usage.list(100);
        if (flags.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else if (rows.length === 0) {
          console.log("no platform usage observations recorded.");
        } else {
          for (const r of rows) {
            console.log(`${r.id}  ${r.label}  ${r.observedAt}  ${r.measurementClass}  ${r.source}/${r.captureMethod}  (${r.precision})`);
          }
        }
      } finally {
        cache.close();
      }
    });

  snapshot
    .command("diff")
    .description("Compare two observations. Refuses when their measurement classes differ.")
    .argument("<before>", "before snapshot id")
    .argument("<after>", "after snapshot id")
    .option("--json", "emit JSON")
    .action((before: string, after: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const usage = new UsageStore(cache.store);
        const d = usage.diff(before, after);
        if (flags.json) {
          console.log(JSON.stringify({ ...d, claim: platformUsageClaim(d) }, null, 2));
        } else {
          console.log(`COMPARABLE  ${d.comparable ? "yes" : "no"}`);
          console.log(`CLASS      ${d.measurementClass}`);
          console.log(`REASON     ${d.reason}`);
          for (const c of d.changes) {
            console.log(`  - ${c.kind}: ${c.before ?? "?"} -> ${c.after ?? "?"} (delta ${c.delta ?? "?"}${c.unit})`);
          }
          console.log(`CLAIM      ${platformUsageClaim(d)}`);
        }
      } finally {
        cache.close();
      }
    });

  const experiment = program.command("experiment")
    .description("Reproducible live experiment sessions.");

  experiment
    .command("create <id>")
    .description("Create an isolated experiment session.")
    .requiredOption("--mode <mode>", "native | inbot | edge")
    .option("--cache-state <state>", "cold | warm", "cold")
    .option("--task-fixture-version <v>", "task fixture version", "v1")
    .option("--repo-fixture-version <v>", "repo fixture version")
    .option("--git-sha <sha>", "git SHA of the code under test")
    .option("--json", "emit JSON")
    .action((id: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const experiments = new ExperimentStore(cache.store);
        const session = experiments.create({
          id,
          mode: opts.mode as never,
          cacheState: (opts.cacheState ?? "cold") as never,
          taskFixtureVersion: String(opts.taskFixtureVersion ?? "v1"),
          repoFixtureVersion: typeof opts.repoFixtureVersion === "string" ? opts.repoFixtureVersion : undefined,
          gitSha: typeof opts.gitSha === "string" ? opts.gitSha : undefined,
          config: { mode: opts.mode, cacheState: opts.cacheState ?? "cold" }
        });
        if (flags.json) console.log(JSON.stringify(session, null, 2));
        else {
          console.log(`SESSION  ${session.id}`);
          console.log(`  mode:          ${session.mode}`);
          console.log(`  cache state:   ${session.cacheState}`);
          console.log(`  db namespace:  ${session.dbNamespace}`);
          console.log(`  cache ns:      ${session.cacheNamespace}`);
          console.log(`  task fixtures: ${session.taskFixtureVersion}`);
          console.log(`  config fp:     ${session.configFingerprint}`);
        }
      } finally {
        cache.close();
      }
    });

  experiment
    .command("record <sessionId> <taskId>")
    .description("Record a task result inside an experiment session.")
    .option("--status <status>", "worker status", "success")
    .option("--success", "task completed successfully", true)
    .option("--no-success", "task did not complete")
    .option("--grokbot-required", "router required GrokBot")
    .option("--grokbot-invoked", "GrokBot was actually invoked")
    .option("--cache-state <state>", "cold | warm")
    .option("--cache-layer <layer>", "cache layer that answered")
    .option("--executor <executor>", "executor that ran")
    .option("--route <route>", "route chosen")
    .option("--elapsed-ms <n>", "elapsed milliseconds", (v) => Number(v), 0)
    .option("--retries <n>", "retry count", (v) => Number(v), 0)
    .option("--context-before <n>", "context chars before", (v) => Number(v))
    .option("--context-after <n>", "context chars after", (v) => Number(v))
    .option("--external-cost-usd <n>", "external worker cost", (v) => Number(v))
    .option("--artifact <ref>", "artifact reference")
    .option("--json", "emit JSON")
    .action((sessionId: string, taskId: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const experiments = new ExperimentStore(cache.store);
        const session = experiments.get(sessionId);
        if (!session) {
          console.error(`session not found: ${sessionId}`);
          process.exitCode = 1;
          return;
        }
        const rec = experiments.record(sessionId, {
          taskId,
          status: String(opts.status ?? "success"),
          success: opts.success !== false,
          grokbotRequired: Boolean(opts.grokbotRequired),
          grokbotInvoked: Boolean(opts.grokbotInvoked),
          cacheState: (opts.cacheState ?? session.cacheState) as never,
          cacheLayer: typeof opts.cacheLayer === "string" ? opts.cacheLayer : null,
          executor: typeof opts.executor === "string" ? opts.executor : null,
          route: typeof opts.route === "string" ? opts.route : null,
          elapsedMs: Number(opts.elapsedMs ?? 0),
          retries: Number(opts.retries ?? 0),
          contextBefore: typeof opts.contextBefore === "number" ? opts.contextBefore : null,
          contextAfter: typeof opts.contextAfter === "number" ? opts.contextAfter : null,
          externalCostUsd: typeof opts.externalCostUsd === "number" ? opts.externalCostUsd : null,
          artifact: typeof opts.artifact === "string" ? opts.artifact : null
        });
        if (flags.json) console.log(JSON.stringify(rec, null, 2));
        else {
          console.log(`RECORDED ${sessionId}/${taskId}`);
          console.log(`  success:       ${rec.success}`);
          console.log(`  grokbot:       required=${rec.grokbotRequired} invoked=${rec.grokbotInvoked}`);
          console.log(`  criteria met:  ${rec.criteriaMet}`);
          console.log(`  counted avoided: ${rec.success && !rec.grokbotInvoked && rec.criteriaMet === true}`);
        }
      } finally {
        cache.close();
      }
    });

  experiment
    .command("attach-snapshot <sessionId>")
    .description("Attach a usage snapshot to a session as its before or after observation.")
    .argument("<which>", "before | after")
    .argument("<snapshotId>", "usage snapshot id")
    .action((sessionId: string, which: string, snapshotId: string) => {
      const flags = resolveFlags(program.opts());
      const cache = openCache(flags);
      try {
        const experiments = new ExperimentStore(cache.store);
        if (which !== "before" && which !== "after") {
          console.error("which must be 'before' or 'after'");
          process.exitCode = 1;
          return;
        }
        experiments.attachSnapshot(sessionId, which, snapshotId);
        console.log(`attached ${which} snapshot ${snapshotId} to ${sessionId}`);
      } finally {
        cache.close();
      }
    });

  experiment
    .command("report <sessionId>")
    .description("Summarize a session, distinguishing eligible tasks from genuine avoidances.")
    .option("--json", "emit JSON")
    .action((sessionId: string, opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const experiments = new ExperimentStore(cache.store);
        const session = experiments.get(sessionId);
        if (!session) {
          console.error(`session not found: ${sessionId}`);
          process.exitCode = 1;
          return;
        }
        const records = experiments.records(sessionId);
        const avoided = experiments.avoidedCount(sessionId);
        const report = {
          session: session.id,
          mode: session.mode,
          cacheState: session.cacheState,
          taskFixtureVersion: session.taskFixtureVersion,
          gitSha: session.gitSha,
          eligibleTasks: experiments.eligibleCount(sessionId),
          genuineAvoidances: avoided,
          grokbotInvocations: records.filter((r) => r.grokbotInvoked).length,
          failures: records.filter((r) => !r.success).length,
          beforeSnapshotId: session.beforeSnapshotId,
          afterSnapshotId: session.afterSnapshotId,
          platformUsage: session.beforeSnapshotId && session.afterSnapshotId ? "see `grokmax usage snapshot diff`" : "unknown"
        };
        if (flags.json) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(`SESSION ${report.session}  mode=${report.mode}  cache=${report.cacheState}`);
          console.log(`  eligible tasks:      ${report.eligibleTasks}`);
          console.log(`  genuine avoidances:  ${report.genuineAvoidances}`);
          console.log(`  grokbot invocations: ${report.grokbotInvocations}`);
          console.log(`  failures:            ${report.failures}`);
          console.log(`  platform usage:      ${report.platformUsage}`);
        }
      } finally {
        cache.close();
      }
    });

  const bench = program
    .command("bench")
    .description("Benchmark manifest tooling that makes mode/cold-warm contamination detectable.");

  bench
    .command("manifest")
    .description("Build a manifest for a benchmark run, with an isolated cache namespace.")
    .requiredOption("--name <name>", "run name")
    .option("--suite-version <v>", "suite version", "v1.0.0")
    .requiredOption("--mode <mode>", "native | inbot | edge")
    .requiredOption("--cache-state <state>", "cold | warm")
    .option("--state-reset <reset>", "fresh-namespace | prune | none", (v) => v)
    .option("--task-fixture-version <v>", "task fixture version", "v1.0.0")
    .option("--repo-fixture-version <v>", "repo fixture version")
    .option("--repo-fixture-path <p>", "disposable fixture repo path")
    .option("--capability <class>", "deterministic | reasoning | repository | browser | cache", "deterministic")
    .option("--git-sha <sha>", "git SHA under test")
    .option("--json", "emit JSON")
    .action((opts: Record<string, unknown>) => {
      const manifest = buildManifest({
        name: String(opts.name),
        version: String(opts.suiteVersion ?? "v1.0.0"),
        mode: opts.mode as never,
        cacheState: opts.cacheState as never,
        stateReset: (opts.stateReset ?? (opts.cacheState === "cold" ? "fresh-namespace" : "none")) as never,
        taskFixtureVersion: String(opts.taskFixtureVersion ?? "v1.0.0"),
        repoFixtureVersion: typeof opts.repoFixtureVersion === "string" ? opts.repoFixtureVersion : null,
        repoFixturePath: typeof opts.repoFixturePath === "string" ? opts.repoFixturePath : null,
        gitSha: typeof opts.gitSha === "string" ? opts.gitSha : null,
        capabilityClass: opts.capability as never
      });
      if (flagsOf(opts).json) console.log(JSON.stringify(manifest, null, 2));
      else console.log(describeManifest(manifest));
    });

  bench
    .command("compare")
    .description("Compare two manifests and refuse when they are not comparable.")
    .requiredOption("--a <path>", "first manifest JSON path")
    .requiredOption("--b <path>", "second manifest JSON path")
    .option("--json", "emit JSON")
    .action((opts: Record<string, unknown>) => {
      const a = JSON.parse(readFileSync(String(opts.a), "utf8")) as BenchmarkManifest;
      const b = JSON.parse(readFileSync(String(opts.b), "utf8")) as BenchmarkManifest;
      const verdict = compareManifests(a, b);
      if (flagsOf(opts).json) console.log(JSON.stringify(verdict, null, 2));
      else {
        console.log(`COMPARABLE ${verdict.comparable ? "yes" : "no"}`);
        console.log(`REASON     ${verdict.reason}`);
        for (const d of verdict.differences) console.log(`  - ${d}`);
      }
      if (!verdict.comparable) process.exitCode = 1;
    });

  bench
    .command("assert-cold")
    .description("Fail a cold run that reused an existing cache namespace.")
    .requiredOption("--manifest <path>", "manifest JSON path")
    .requiredOption("--namespace-exists", "set when the namespace already exists on disk")
    .action((opts: Record<string, unknown>) => {
      const m = JSON.parse(readFileSync(String(opts.manifest), "utf8")) as BenchmarkManifest;
      assertColdStateHonest(m, Boolean(opts.namespaceExists));
      console.log(`cold state OK for ${m.name} (namespace ${m.cacheNamespace})`);
    });

  bench
    .command("reset-fixture")
    .description("Recreate a disposable fixture repo from its fixture.json so edits cannot leak between modes.")
    .requiredOption("--path <p>", "fixture repo path")
    .action((opts: Record<string, unknown>) => {
      const p = String(opts.path);
      const spec = JSON.parse(readFileSync(join(p, "fixture.json"), "utf8")) as {
        name: string;
        version: string;
        files: Array<{ path: string; content: string }>;
      };
      for (const f of spec.files) {
        const target = join(p, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, "utf8");
      }
      console.log(`reset fixture ${spec.name}@${spec.version} (${spec.files.length} files) in ${p}`);
    });

  program
    .command("savings")
    .description("Honest savings report (proxy by default; measured if imported).")
    .option("--json", "emit JSON")
    .action(async (opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const ledger = new Ledger(cache.store);
        const report = await computeSavings(cache, ledger);
        if (flags.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(savingsLine(report));
          console.log();
          for (const caveat of report.caveats) console.log(`  note: ${caveat}`);
        }
      } finally {
        cache.close();
      }
    });

  program
    .command("benchmark")
    .description("Run benchmark suites against fixtures (measured on this machine).")
    .option("--json", "emit JSON")
    .action(async (opts: Record<string, unknown>) => {
      const { runBenchmarks, formatBenchmark } = await import("./benchmark.js");
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const result = await runBenchmarks(flags.cwd);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log(formatBenchmark(result));
    });

  program
    .command("doctor")
    .description("Health checks across every subsystem.")
    .option("--json", "emit JSON")
    .action(async (opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const registry: ProviderRegistry = createDefaultRegistry();
        const { benchmarkFixturesPresent } = await import("./benchmark.js");
        const res = await runDoctor({
          cache,
          providerDetect: () => registry.detectSet(),
          benchmarkFixturesPresent: benchmarkFixturesPresent(flags.cwd)
        });
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`STATUS: ${res.status.toUpperCase()}`);
          console.log(`SUMMARY: ${res.summary}`);
          for (const c of res.checks) {
            const mark = c.status === "healthy" ? "✓" : c.status === "warning" ? "!" : "✗";
            console.log(`  ${mark} ${c.name}: ${c.detail}`);
          }
        }
      } finally {
        cache.close();
      }
    });

  program
    .command("status")
    .description("Aggregate status: doctor + cache + ledger + savings in one view.")
    .option("--json", "emit JSON")
    .action(async (opts: Record<string, unknown>) => {
      const flags = resolveFlags({ ...program.opts(), ...opts });
      const cache = openCache(flags);
      try {
        const ledger = new Ledger(cache.store);
        const registry: ProviderRegistry = createDefaultRegistry();
        const { benchmarkFixturesPresent } = await import("./benchmark.js");
        const [doctor, report] = await Promise.all([
          runDoctor({ cache, providerDetect: () => registry.detectSet(), benchmarkFixturesPresent: benchmarkFixturesPresent(flags.cwd) }),
          computeSavings(cache, ledger)
        ]);
        if (flags.json) {
          console.log(JSON.stringify({ doctor: doctor.status, doctorSummary: doctor.summary, savings: report.method }, null, 2));
        } else {
          const s = ledger.summary();
          console.log(box("grokmax status"));
          console.log(`  doctor:      ${doctor.status.toUpperCase()}`);
          console.log(`  runs:        ${s.runs} (${s.successes} ok)  cache hits ${s.cacheHits}`);
          console.log(`  savings:     ${savingsLine(report)}`);
          console.log(`  db:          ${process.env.GROKMAX_DB ?? "<cwd>/data/grokmax.db"}`);
          console.log(`  providers:   ${[...registry.detectSet()].join(", ") || "(none)"}`);
        }
      } finally {
        cache.close();
      }
    });

  await program.parseAsync(process.argv);
}

async function mainWithGuard(): Promise<void> {
  try {
    await main();
  } catch (err) {
    console.error(`grokmax: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

void mainWithGuard();