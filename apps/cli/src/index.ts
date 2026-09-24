#!/usr/bin/env node
/**
 * GrokMax CLI.
 *
 * Minimize GrokBot usage while maximizing verified useful output.
 *
 *   grokmax optimize "<goal>"       full pipeline run, prints plan + outcome
 *   grokmax run <intent> <goal>     explicit run
 *   grokmax ask "<question>"        shorthand for intent=goal=question
 *   grokmax route "<goal>"          routing decision only (no execution)
 *   grokmax dry-run "<goal>"        plan + outcome without executing
 *   grokmax explain <runId>         describe a completed run
 *   grokmax cache stats|prune|clear
 *   grokmax usage                   ledger summary
 *   grokmax savings                 honest savings report (proxy/measured)
 *   grokmax benchmark [suite...]    run benchmark suites against fixtures
 *   grokmax doctor                  health checks
 *   grokmax status                  overall system status
 */
import { Command } from "commander";
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
import { GrokMaxEngine, type GrokMaxTask, type CompiledPrompt } from "@grokmax/core";
import { runDoctor } from "@grokmax/doctor";
import { computeSavings, savingsLine } from "@grokmax/telemetry";
import { collectRawContext } from "./context.js";

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
    .version("0.1.0")
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

  program
    .command("usage")
    .description("Ledger summary with honest measured/estimated labels.")
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
        const res = await runDoctor({
          cache,
          providerDetect: () => registry.detectSet(),
          benchmarkFixturesPresent: flags.cwd.endsWith("grokmax")
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
        const [doctor, report] = await Promise.all([
          runDoctor({ cache, providerDetect: () => registry.detectSet(), benchmarkFixturesPresent: true }),
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