#!/usr/bin/env node
/**
 * GrokMax In-Bot wrapper.
 *
 * A thin, auditable shim a GrokBot skill (or any agent runtime) can call to run
 * the In-Bot preflight contract and get back one machine-readable JSON object.
 * It does no routing, caching, or execution of its own: it only guarantees that
 * a GrokBot decision is driven by a recorded preflight rather than a guess.
 *
 * Usage:
 *   node skills/grokmax/inbot.mjs "<task>"            # preflight, print JSON
 *   node skills/grokmax/inbot.mjs "<task>" --explain  # preflight, print guidance
 *
 * Exit codes:
 *   0  a usable decision was produced (reuse, delegate, or GrokBot-required)
 *   1  decision was FAIL — no capable route, do not spend
 *   2  preflight itself could not run
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI = join(REPO_ROOT, "apps", "cli", "src", "index.ts");

const VALID_ACTIONS = new Set(["RETURN_EXISTING_RESULT", "DELEGATE", "GROKBOT_REQUIRED", "FAIL"]);

function findTsx() {
  const direct = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(direct)) return direct;
  throw new Error("could not locate tsx; run `pnpm install` in the grokmax repo");
}

export function runPreflight(task) {
  const tsx = findTsx();
  const res = spawnSync(process.execPath, [tsx, CLI, "preflight", task, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120000
  });
  if (res.error) throw res.error;
  const stdout = (res.stdout ?? "").trim();
  if (!stdout) throw new Error(`preflight produced no output (status ${res.status}): ${res.stderr ?? ""}`);
  const parsed = JSON.parse(stdout);
  if (!VALID_ACTIONS.has(parsed.action)) throw new Error(`preflight returned an unknown action: ${parsed.action}`);
  return parsed;
}

function explain(decision) {
  const lines = [`ACTION: ${decision.action}`, `REASON: ${decision.reason}`, "", "DO THIS:", `  ${decision.instruction}`];
  if (decision.action === "DELEGATE" && decision.delegateTo) lines.push(`  Hand off to: ${decision.delegateTo}`);
  if (decision.microPrompt) lines.push("", "MICRO-PROMPT (use verbatim, do not expand):", decision.microPrompt);
  if (decision.summary) {
    lines.push("", `EXISTING RESULT: ${decision.summary}`);
    if (decision.artifact) lines.push(`ARTIFACT: ${decision.artifact}`);
  }
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const explainMode = argv.includes("--explain");
  const task = argv.filter((a) => a !== "--explain").join(" ").trim();

  if (!task) {
    console.error('usage: inbot.mjs "<task>" [--explain]');
    process.exitCode = 2;
    return;
  }

  let decision;
  try {
    decision = runPreflight(task);
  } catch (err) {
    console.error(`preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  console.log(explainMode ? explain(decision) : JSON.stringify(decision, null, 2));
  process.exitCode = decision.action === "FAIL" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
