/**
 * Collect raw context units for a task: referenced files, durable rules, and
 * dependency manifests. Reads happen lazily and never fail the pipeline.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContextUnit, GrokMaxTask } from "@grokmax/core";

const RULE_FILES = ["AGENTS.md", "CONTRIBUTING.md", "grokmax.rules.md", ".grokmax/rules.md"];

export function collectRawContext(task: GrokMaxTask, cwd: string): ContextUnit[] {
  const units: ContextUnit[] = [];

  const refs = task.contextRefs ?? [];
  for (const ref of refs) {
    if (ref.startsWith("grokmax://")) continue;
    const abs = resolve(cwd, ref);
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size < 1_000_000) {
        const content = readFileSync(abs, "utf8");
        units.push({ id: ref, kind: "file", content, bytes: st.size });
      }
    } catch {
      // unreadable refs are skipped; slicer still works on the rest
    }
  }

  for (const rule of RULE_FILES) {
    const abs = join(cwd, rule);
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size < 500_000) {
        const content = readFileSync(abs, "utf8");
        units.push({ id: rule, kind: "rule", content, bytes: st.size });
      }
    } catch {
      // skip
    }
  }

  // Loose directory match: when no explicit refs, scan the cwd for a small
  // set of likely-relevant files (top-level only) so interactive runs have
  // *some* context to slice without crawling the whole repo.
  if (units.length === 0) {
    let entries = [] as string[];
    try {
      entries = readdirSync(cwd).slice(0, 400);
    } catch {
      return units;
    }
    const wildcards = new Set([".", "./"]);
    let anyParentRef = false;
    for (const ref of refs) if (wildcards.has(ref) || ref.endsWith("/")) anyParentRef = true;
    if (anyParentRef || refs.length === 0) {
      for (const entry of entries) {
        if (entry.startsWith(".") || entry.startsWith("node_modules") || entry === "dist" || entry === "data" || entry === "coverage") continue;
        const abs = join(cwd, entry);
        try {
          const st = statSync(abs);
          if (st.isDirectory()) continue;
          if (!/\.(md|ts|tsx|js|mjs|cjs|json|txt|yml|yaml|toml|env|cfg|conf|sh)$/i.test(entry)) continue;
          if (st.size > 400_000) continue;
          const content = readFileSync(abs, "utf8");
          units.push({ id: entry, kind: "file", content, bytes: st.size });
        } catch {
          // skip
        }
      }
    }
  }

  return units;
}