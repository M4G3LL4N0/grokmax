import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve as pathResolve, sep } from "node:path";
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
      const abs = resolveWithin(ref, cwd);
      if (abs && existsSync(abs)) {
        parts.push(`file:${abs}:${hashFile(abs)}`);
      } else if (abs) {
        parts.push(`missing:${ref}`);
      } else {
        parts.push(`containment-rejected:${ref}`);
      }
    } else {
      parts.push(`ref:${ref}`);
    }
  }

  const gitHead = headSha(cwd);
  if (gitHead) parts.push(`git:${gitHead}`);

  const env = envDeps();
  if (env.length > 0) parts.push(`env:${env.join("|")}`);

  const version = "grokmax-v0.1.1";
  parts.push(`v:${version}`);

  return createHash("sha256").update(parts.join("::")).digest("hex");
}

function isLocalPath(ref: string): boolean {
  return ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref);
}

const ENCODED_TRAVERSAL = /(?:%2e%2e|%2e\.|\.%2e|%2E%2E|%252e%252e|\.%2f|\.%5c|%2e%2e%2f|%2e%2e%5c)/i;

/**
 * Resolve a workspace path but never leave `cwd`. Rejects traversal refs
 * (../), absolute refs outside cwd, symlinks that resolve outside, and
 * URL-encoded traversal. Returns null for a containment violation.
 */
export function resolveWithin(ref: string, cwd: string): string | null {
  if (ENCODED_TRAVERSAL.test(ref)) return null;
  const abs = pathResolve(cwd, ref);
  if (!isWithin(abs, cwd)) return null;
  try {
    const realAbs = realpathSync(abs);
    if (!isWithin(realAbs, realpathSync(cwd))) return null;
  } catch {
    // Lexically contained path that does not exist (yet) is acceptable.
  }
  return abs;
}

function isWithin(p: string, base: string): boolean {
  if (p === base) return true;
  const rel = relative(base, p);
  return !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel);
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