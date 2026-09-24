/**
 * GrokBot bridge.
 *
 * GrokMax must never fabricate GrokBot invocation. This adapter activates only
 * when GROKMAX_GROKBOT_BRIDGE points to an executable script that performs the
 * GrokBot handoff and emits a WorkerResult JSON on stdout. Otherwise the adapter
 * is unavailable and the router treats GrokBot as off, producing an explicit
 * handoff prompt instead so an operator (or the GrokBot skill) can complete it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledPrompt, GrokMaxTask, WorkerResult } from "@grokmax/core";
import type { Provider } from "@grokmax/providers";

export type GrokBotOptions = { projectDir?: string };

export class GrokBotProvider implements Provider<GrokBotOptions> {
  readonly id = "grokbot" as const;

  constructor(private readonly opts: GrokBotOptions = {}) {}

  private bridge(): string | undefined {
    return process.env.GROKMAX_GROKBOT_BRIDGE ?? undefined;
  }

  detect(): boolean {
    const bridge = this.bridge();
    if (!bridge) return false;
    return existsSync(bridge);
  }

  async execute(compiled: CompiledPrompt, task: GrokMaxTask, _opts?: { projectDir?: string }): Promise<WorkerResult> {
    const bridge = this.bridge();
    if (!bridge || !existsSync(bridge)) {
      return this.unavailable(compiled);
    }
    const dir = mkdtempSync(join(tmpdir(), "grokmax-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, compiled.prompt, "utf8");
    const taskFile = join(dir, "task.json");
    writeFileSync(taskFile, JSON.stringify(task), "utf8");

    const r = spawnSync(bridge, [promptFile, taskFile], { encoding: "utf8", timeout: 60 * 60 * 1000 });
    if (r.error || r.status !== 0) {
      return {
        status: "failure",
        executor: "grokbot",
        summary: `grokbot bridge failed: ${(r.error?.message ?? "").slice(0, 400) || r.stderr?.slice(0, 400)}`,
        evidence: [],
        grokbotRequired: true
      };
    }
    try {
      const parsed = JSON.parse(r.stdout.trim()) as Partial<WorkerResult>;
      return {
        status: parsed.status ?? "success",
        executor: "grokbot",
        summary: parsed.summary ?? "grokbot completed",
        artifact: parsed.artifact,
        evidence: parsed.evidence ?? ["grokbot bridge completed"],
        grokbotRequired: true,
        costUsd: parsed.costUsd ?? null,
        tokensEstimate: parsed.tokensEstimate ?? compiled.tokensEstimate,
        rawOutput: r.stdout.slice(0, 8000)
      };
    } catch {
      return {
        status: "failure",
        executor: "grokbot",
        summary: "grokbot bridge output was not valid JSON",
        evidence: [],
        grokbotRequired: true,
        rawOutput: r.stdout.slice(0, 8000)
      };
    }
  }

  private unavailable(compiled: CompiledPrompt): WorkerResult {
    return {
      status: "failure",
      executor: "grokbot",
      summary: [
        "GrokBot bridge not configured (GROKMAX_GROKBOT_BRIDGE). Execution blocked by design.",
        "If this task truly requires GrokBot, copy the compiled micro-prompt into GrokBot.",
        compiled.prompt.slice(0, 4000)
      ].join("\n"),
      evidence: ["GrokBot was not invoked; no fabricated usage."],
      grokbotRequired: true,
      rawOutput: compiled.prompt
    };
  }
}

/**
 * Manual measurement import is supported via the ledger, not invented here:
 * `grokmax usage import --run <id> --before <n> --after <n> --calls <n>`.
 */
export type ManualUsage = { before: number; after: number; grokbotCalls: number };