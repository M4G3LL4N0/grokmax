/**
 * Benchmark runner: executes fixture suites on this machine and reports
 * honest, measured numbers (runs are executed via the DeterministicProvider
 * only, so nothing costs money and no external model participates).
 *
 * Fixtures live under <root>/benchmarks/suites/<suite>/ and describe tasks with
 * the fields: id, intent, goal, constraints?, freshness?, expectedResolver?,
 * and optional expectedOutcomeRegex.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { GrokMaxCache } from "@grokmax/cache";
import { createDefaultRegistry } from "@grokmax/adapters";
import type { GrokMaxTask } from "@grokmax/core";

export interface BenchmarkFixture {
  id: string;
  intent: string;
  goal: string;
  constraints?: string[];
  freshness?: GrokMaxTask["freshness"];
  expectedResolver?: string;
  expectedOutcomeRegex?: string;
}

export interface FixtureResult {
  id: string;
  route: string;
  status: string;
  expectedResolverMatched: boolean;
  outcomeMatched: boolean;
  elapsedMs: number;
  cacheLayer: string;
  grokbotRequired: boolean;
  summary: string;
}

export interface BenchmarkReport {
  generatedAt: string;
  suites: Array<{
    dir: string;
    fixtures: FixtureResult[];
    measured: {
      totalElapsedMs: number;
      resolveAccuracy: number;
      outcomeAccuracy: number;
      grokbotRequiredCount: number;
    };
  }>;
}

const SUITE_DIR = "benchmarks/suites";

/**
 * True when `cwd` contains at least one `benchmarks/suites/<suite>/*.json`.
 * The directory basename is irrelevant — a clone named `grokmax-verify` still
 * counts. An empty or missing suites directory does not.
 */
export function benchmarkFixturesPresent(cwd: string): boolean {
  const suitesRoot = resolve(cwd, SUITE_DIR);
  if (!existsSync(suitesRoot)) return false;
  let entries: string[];
  try {
    entries = readdirSync(suitesRoot);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const dir = join(suitesRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    if (files.some((f) => f.endsWith(".json"))) return true;
  }
  return false;
}

function loadFixtures(suiteDir: string): BenchmarkFixture[] {
  const files = readdirSync(suiteDir).filter((f) => f.endsWith(".json")).sort();
  const fixtures: BenchmarkFixture[] = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(suiteDir, file), "utf8"));
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) fixtures.push(item as BenchmarkFixture);
  }
  return fixtures;
}

export async function runBenchmarks(cwd: string): Promise<BenchmarkReport> {
  const root = resolve(cwd);
  const suitesRoot = resolve(root, SUITE_DIR);
  const report: BenchmarkReport = { generatedAt: new Date().toISOString(), suites: [] };

  if (!existsSync(suitesRoot)) {
    return { ...report, suites: [] };
  }

  const suiteDirs = readdirSync(suitesRoot)
    .map((d) => join(suitesRoot, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  const cache = new GrokMaxCache(process.env.GROKMAX_DB, { cwd: root });

  try {
    const registry = createDefaultRegistry();

    for (const dir of suiteDirs) {
      const fixtures = loadFixtures(dir);
      const results: FixtureResult[] = [];
      let totalElapsedMs = 0;
      let resolveMatched = 0;
      let outcomeMatched = 0;
      let grokbotRequiredCount = 0;

      for (const fx of fixtures) {
        const task: GrokMaxTask = {
          intent: fx.intent,
          goal: fx.goal,
          constraints: fx.constraints,
          freshness: fx.freshness ?? "never-cache"
        };
        const startedAt = Date.now();
        const cp = { prompt: fx.goal, inputChars: fx.goal.length, outputChars: 0, tokensEstimate: 0, preserved: [], removed: [], validation: { ok: true, issues: [], preservedConstraints: [], lostConstraints: [] }, stages: [] };
        const worker = await registry.execute("deterministic", cp, task);
        const elapsedMs = Date.now() - startedAt;
        totalElapsedMs += elapsedMs;

        const expectedResolverMatched = fx.expectedResolver == null || worker.executor === fx.expectedResolver;
        const hasOutcomeMatch = fx.expectedOutcomeRegex == null || new RegExp(fx.expectedOutcomeRegex).test(worker.summary ?? "");
        if (expectedResolverMatched) resolveMatched += 1;
        if (hasOutcomeMatch) outcomeMatched += 1;
        if (worker.grokbotRequired) grokbotRequiredCount += 1;

        results.push({
          id: fx.id,
          route: worker.executor,
          status: worker.status,
          expectedResolverMatched,
          outcomeMatched: hasOutcomeMatch,
          elapsedMs,
          cacheLayer: "none",
          grokbotRequired: worker.grokbotRequired,
          summary: worker.summary
        });
      }

      report.suites.push({
        dir,
        fixtures: results,
        measured: {
          totalElapsedMs,
          resolveAccuracy: fixtures.length === 0 ? 0 : Math.round((resolveMatched / fixtures.length) * 1000) / 10,
          outcomeAccuracy: fixtures.length === 0 ? 0 : Math.round((outcomeMatched / fixtures.length) * 1000) / 10,
          grokbotRequiredCount
        }
      });
    }
  } finally {
    cache.close();
  }

  return report;
}

export function formatBenchmark(report: BenchmarkReport): string {
  if (report.suites.length === 0) return "no benchmark suites found (benchmarks/suites/<suite>/*.json)";
  let out = "GROKMAX BENCHMARKS (measured on this machine; deterministic-only, no spend)\n";
  for (const suite of report.suites) {
    out += `\n${suite.dir}\n`;
    out += `  resolve accuracy: ${suite.measured.resolveAccuracy}%\n`;
    out += `  outcome accuracy: ${suite.measured.outcomeAccuracy}%\n`;
    out += `  grokbot required: ${suite.measured.grokbotRequiredCount}\n`;
    for (const fx of suite.fixtures) {
      const flags = [
        fx.expectedResolverMatched ? "resolver-ok" : "resolver-X",
        fx.outcomeMatched ? "outcome-ok" : "outcome-X"
      ].join("/");
      out += `    - ${fx.id}: ${fx.route} ${fx.status} (${fx.elapsedMs}ms) [${flags}] ${fx.summary.slice(0, 60)}\n`;
    }
  }
  return out;
}