/**
 * OpenCode CLI adapter: repository inspection & modification work.
 * Invokes `opencode run` with the compiled micro-prompt.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { CompiledPrompt, GrokMaxTask, WorkerResult } from "@grokmax/core";
import type { Provider } from "@grokmax/providers";

export type OpenCodeOptions = {
  bin?: string;
  projectDir?: string;
  timeoutMs?: number;
};

type OpenCodeRun = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  spawnError: string | null;
};

export class OpenCodeProvider implements Provider<OpenCodeOptions> {
  readonly id = "opencode" as const;

  constructor(private readonly opts: OpenCodeOptions = {}) {}

  private bin(): string {
    return this.opts.bin ?? process.env.GROKMAX_OPENCODE_BIN ?? "opencode";
  }

  detect(): boolean {
    return checkBin(this.bin());
  }

  availableCwd(task: GrokMaxTask): string {
    const override = this.opts.projectDir;
    if (override) return override;
    const ctxDir = (task.contextRefs ?? []).find((r) => r.startsWith("/") || r.startsWith("./") || r.startsWith("../"));
    if (ctxDir) return pathResolve(ctxDir);
    return process.cwd();
  }

  async execute(compiled: CompiledPrompt, task: GrokMaxTask, opts?: OpenCodeOptions): Promise<WorkerResult> {
    const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs ?? 10 * 60 * 1000;
    const cwd = opts?.projectDir ?? this.availableCwd(task);

    const result = await runSpawn(this.bin(), ["run", compiled.prompt], { cwd, timeoutMs });

    if (result.timedOut) {
      return {
        status: "failure",
        executor: "opencode",
        summary: "opencode run timed out",
        evidence: [],
        grokbotRequired: false,
        tokensEstimate: compiled.tokensEstimate
      };
    }

    if (result.spawnError || result.exitCode !== 0) {
      const why = result.spawnError
        ? `opencode failed to start: ${result.spawnError}`
        : `opencode exited with code ${result.exitCode ?? "unknown"}`;
      const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
      return {
        status: "failure",
        executor: "opencode",
        summary: detail ? `${why}: ${detail}` : why,
        evidence: [],
        grokbotRequired: false,
        tokensEstimate: compiled.tokensEstimate,
        rawOutput: result.stdout.slice(0, 8000)
      };
    }

    const parsed = parseOpenCodeOutput(result.stdout);
    if (parsed) {
      return {
        status: parsed.status === "error" ? "failure" : "success",
        executor: "opencode",
        summary: parsed.message ?? "opencode completed",
        artifact: parsed.artifact,
        evidence: [parsed.system ?? "opencode run completed"].filter(Boolean),
        grokbotRequired: false,
        tokensEstimate: compiled.tokensEstimate,
        rawOutput: result.stdout.slice(0, 8000)
      };
    }

    const summary = result.stdout.trim().slice(0, 2000) || result.stderr.trim().slice(0, 2000) || "(no output)";
    return {
      status: "success",
      executor: "opencode",
      summary,
      evidence: ["opencode run completed"],
      grokbotRequired: false,
      tokensEstimate: compiled.tokensEstimate,
      rawOutput: result.stdout.slice(0, 8000)
    };
  }
}

function checkBin(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  try {
    const r = spawnSync(bin, ["--version"], { timeout: 5000, stdio: "pipe" });
    return !r.error && (r.status ?? -1) === 0;
  } catch {
    return false;
  }
}

function runSpawn(bin: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<OpenCodeRun> {
  return new Promise<OpenCodeRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, args, { cwd: opts.cwd });
    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, exitCode, spawnError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => finish(null, err.message));
    child.on("close", (code) => finish(code, null));
  });
}

type OpenCodeJson = { status?: string; message?: string; artifact?: string; system?: string };

function parseOpenCodeOutput(stdout: string): OpenCodeJson | null {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const arr = JSON.parse(trimmed.split("\n").find((l) => l.startsWith("[")) ?? trimmed);
      const last = Array.isArray(arr) ? (arr.at(-1) as OpenCodeJson | undefined) : (JSON.parse(trimmed) as OpenCodeJson);
      if (last && typeof last === "object") return last;
    } catch {
      // fall through to regex
    }
  }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]) as OpenCodeJson;
    } catch {
      return null;
    }
  }
  return null;
}