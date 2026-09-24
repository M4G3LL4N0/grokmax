/**
 * Micro-prompt compiler.
 *
 * Turns a raw task (goal, constraints, sliced context, history, output schema)
 * into a compact execution prompt. Constraints, numbers, paths, names, output
 * format, approval boundaries and stop conditions are preserved verbatim.
 */
import type { CompiledPrompt, GrokMaxTask } from "@grokmax/core";
import { estimateTokens } from "@grokmax/core";
import { collapseRepeatedLines, compressWording, extractHardConstraints, extractStopConditions } from "./constraint.js";

export { extractHardConstraints, extractStopConditions, compressWording, collapseRepeatedLines } from "./constraint.js";

const DEFAULT_OUTPUT_SCHEMAS: Record<string, string> = {
  answer: `Return a concise answer.`,
  artifact: `Return JSON only:
{
  "status": "success|failure|partial",
  "executor": "<name>",
  "summary": "<one sentence>",
  "artifact": "grokmax://artifact/<id> or null",
  "evidence": ["<verifiable check>", ...],
  "grokbotRequired": false
}`,
  action: `Perform the action, then return JSON only:
{
  "status": "success|failure|partial",
  "executor": "<name>",
  "summary": "<what was done>",
  "artifact": "grokmax://artifact/<id> or null",
  "evidence": ["<verifiable check>", ...],
  "grokbotRequired": false
}`
};

export interface CompileInput {
  task: GrokMaxTask;
  selectedContext: string[];
  history?: string[];
}

interface Stage {
  name: string;
  beforeChars: number;
  afterChars: number;
  note?: string;
}

export function compile(opts: CompileInput): CompiledPrompt {
  const stages: Stage[] = [];
  const removed: string[] = [];

  const recordStage = (name: string, before: number, after: number, note?: string): void => {
    stages.push({ name, beforeChars: before, afterChars: after, note });
  };

  // ---- normalize goal & intent ----
  const goal = compressWording([opts.task.goal, opts.task.intent].filter(Boolean).join("\n"));
  recordStage("normalize-goal", (opts.task.goal + "\n" + opts.task.intent).length, goal.length);

  // ---- hard constraints: explicit + scanned from every input ----
  const explicitConstraints = [...new Set((opts.task.constraints ?? []).map((c) => c.replace(/\s+/g, " ").trim()))];
  const scanned: string[] = [];
  for (const unit of [opts.task.goal, opts.task.intent, ...opts.selectedContext, ...(opts.history ?? [])]) {
    for (const c of extractHardConstraints(unit)) {
      if (!explicitConstraints.includes(c)) scanned.push(c);
    }
  }
  const constraints = [...new Set([...explicitConstraints, ...scanned])];

  // ---- context: dedupe, collapse, compress wording ----
  const contextJoined = opts.selectedContext.join("\n\n");
  recordStage("context-raw", contextJoined.length, contextJoined.length);
  const contextLines = collapseRepeatedLines(contextJoined);
  recordStage("context-dedupe", contextJoined.length, contextLines.length, "collapsed repeated rules");
  const compressedContext = compressWording(contextLines);
  recordStage("context-compress", contextLines.length, compressedContext.length, "word-level compression");

  // ---- history: keep only tail, dedupe ----
  let historyTail = "";
  if (opts.history && opts.history.length > 0) {
    const deduped = [...new Set(opts.history.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))];
    historyTail = compressWording(deduped.slice(-6).join("\n"));
  }

  // ---- stop conditions ----
  const stopConditions = extractStopConditions([goal, ...constraints].join("\n"), constraints);
  if (stopConditions.length === 0) {
    stopConditions.push("Do not exceed the explicit boundaries above.");
  }

  // ---- output schema ----
  const schema = DEFAULT_OUTPUT_SCHEMAS[opts.task.output ?? "answer"] ?? DEFAULT_OUTPUT_SCHEMAS.answer;

  // ---- build the compiled prompt ----
  const header = ["GOAL", goal].join("\n");
  const ctx = ["CONTEXT", compressedContext].join("\n");
  const con = ["HARD CONSTRAINTS", ...constraints.map((c) => `- ${c}`)].join("\n");
  const schemaBlock = ["OUTPUT FORMAT", schema].join("\n");
  const stop = ["STOP CONDITIONS", ...stopConditions.map((s) => `- ${s}`)].join("\n");
  const hist = historyTail ? ["PRIOR TAIL", historyTail].join("\n") : "";

  const prompt = [header, ctx, con, schemaBlock, stop, hist].filter(Boolean).join("\n\n");
  recordStage("assemble", goal.length + contextJoined.length, prompt.length);

  // ---- validation: semantic equivalence of constraints ----
  const { ok, issues, preservedConstraints, lostConstraints } = validatePreservation(constraints, prompt);

  // ---- tracking ----
  if (!ok) {
    removed.push(...lostConstraints);
  }

  const inputChars = goal.length + contextJoined.length + (opts.history?.join("").length ?? 0) + explicitConstraints.join("").length;

  return {
    prompt,
    inputChars,
    outputChars: prompt.length,
    tokensEstimate: estimateTokens(prompt.length),
    preserved: [...new Set(constraints)],
    removed: [...new Set(removed)],
    validation: {
      ok,
      issues,
      preservedConstraints,
      lostConstraints
    },
    stages
  };
}

/**
 * Preservation check. A constraint is kept only when its full text survives in
 * the prompt at a token boundary and every significant token does too.
 * Substring containment is not enough: `$50` is not preserved by `$500`, and
 * `3` is not preserved by `30`. Negation and obligation words (`not`, `never`,
 * `must`, `only`, `do`) are mandatory — they are not stopwords. This means
 * "deploy" alone can never satisfy "do not deploy".
 */
export function validatePreservation(
  constraints: string[],
  prompt: string
): { ok: boolean; issues: string[]; preservedConstraints: string[]; lostConstraints: string[] } {
  const promptNorm = normalizeForPreservation(prompt);
  const preservedConstraints: string[] = [];
  const lostConstraints: string[] = [];
  const issues: string[] = [];

  for (const c of constraints) {
    const norm = normalizeForPreservation(c);
    const tokens = significant(c);
    const verbatimMissing = norm.length > 0 && !containsAtTokenBoundary(promptNorm, norm);
    const misses = tokens.filter((t) => !containsAtTokenBoundary(promptNorm, t));
    if (!verbatimMissing && misses.length === 0) {
      preservedConstraints.push(c);
    } else {
      lostConstraints.push(c);
      if (verbatimMissing) issues.push(`constraint '${c}' not preserved verbatim`);
      if (misses.length > 0) issues.push(`constraint '${c}' lost tokens: ${misses.join(", ")}`);
    }
  }

  return { ok: lostConstraints.length === 0, issues, preservedConstraints, lostConstraints };
}

/**
 * True when `needle` occurs in `haystack` without being a prefix or infix of a
 * longer literal. Digits, letters, `_`, a following `%` or apostrophe, and a
 * decimal/thousands continuation (`.5`, `,000`) all extend the literal, so
 * `$50` does not match inside `$500` or `$50.00`.
 */
function containsAtTokenBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    if (!matchExtendsLiteral(haystack, i, i + needle.length)) return true;
    from = i + 1;
  }
  return false;
}

function matchExtendsLiteral(haystack: string, start: number, end: number): boolean {
  if (start > 0) {
    const before = haystack[start - 1];
    if (before !== undefined && isLiteralBody(before)) return true;
  }
  return literalContinues(haystack, end);
}

function isLiteralBody(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

function literalContinues(haystack: string, index: number): boolean {
  const ch = haystack[index];
  if (ch === undefined) return false;
  if (isLiteralBody(ch)) return true;
  if (ch === "%" || ch === "'" || ch === "’") return true;
  if (ch === "." || ch === ",") {
    const next = haystack[index + 1];
    return next !== undefined && /\d/u.test(next);
  }
  return false;
}

function normalizeForPreservation(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function significant(c: string): string[] {
  const stop = new Set(["the", "and", "for", "you", "your", "this", "that", "with", "an", "a", "to", "of", "in", "on", "by", "at", "are", "is", "be", "will"]);
  return normalizeForPreservation(c)
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stop.has(t));
}

export function compileAdaptive(opts: CompileInput): CompiledPrompt {
  return compile(opts);
}