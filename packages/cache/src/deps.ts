import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import type { GrokMaxTask } from "@grokmax/core";

/**
 * Dependency fingerprint covers everything a cached result could depend on:
 * referenced files (content hash), the enclosing git HEAD, and configured
 * environment. A change in any of these invalidates dependent cache entries.
 */
export function computeDependencyFingerprint(task: GrokMaxTask, opts: { cwd?: string } = {}): string {
  const parts: string[] = [];
  const cwd = opts.cwd ?? process.cwd();

  for (const ref of task.contextRefs ?? []) {
    if (ref.startsWith("grokmax://")) continue;
    if (isLocalPath(ref)) {
      const abs = resolvePath(ref, cwd);
      if (existsSync(abs)) {
        parts.push(`file:${abs}:${hashFile(abs)}`);
      } else {
        parts.push(`missing:${ref}`);
      }
    } else {
      parts.push(`ref:${ref}`);
    }
  }

  const gitHead = headSha(cwd);
  if (gitHead) parts.push(`git:${gitHead}`);

  const env = envDeps();
  if (env.length > 0) parts.push(`env:${env.join("|")}`);

  const version = "grokmax-v0.1.0";
  parts.push(`v:${version}`);

  return createHash("sha256").update(parts.join("::")).digest("hex");
}

function isLocalPath(ref: string): boolean {
  return ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref);
}

function resolvePath(ref: string, cwd: string): string {
  return pathResolve(cwd, ref);
}

function hashFile(p: string): string {
  try {
    const st = statSync(p);
    if (st.size > 16 * 1024 * 1024) {
      return `big:${st.size}:${st.mtimeMs.toFixed(0)}`;
    }
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return "unreadable";
  }
}

function headSha(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    });
    return out.trim();
  } catch {
    return undefined;
  }
}

function envDeps(): string[] {
  const names = Object.keys(process.env).filter((k) => k.startsWith("GROKMAX_"));
  return names.sort().map((k) => `${k}=${process.env[k] ?? ""}`);
}