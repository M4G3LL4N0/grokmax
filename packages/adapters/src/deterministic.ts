/**
 * Deterministic local executor: resolve eligible tasks with zero intelligence
 * cost. Each resolver returns a WorkerResult. Anything not resolvable is a
 * graceful failure, forcing routing to a capable worker instead.
 */
import type { CompiledPrompt, GrokMaxTask, WorkerResult } from "@grokmax/core";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

export class DeterministicProvider {
  readonly id = "deterministic" as const;

  detect(): boolean {
    return true;
  }

  async execute(compiled: CompiledPrompt, task: GrokMaxTask): Promise<WorkerResult> {
    const text = `${task.goal}\n${task.intent}\n${compiled.prompt}`;
    const math = tryMath(text);
    if (math !== null) return math;
    const hash = tryHash(text);
    if (hash !== null) return hash;
    const count = tryCount(text);
    if (count !== null) return count;
    const git = tryGit(text);
    if (git !== null) return git;

    return {
      status: "failure",
      executor: "deterministic",
      summary: "no deterministic local resolver matched this task",
      evidence: [],
      grokbotRequired: false
    };
  }
}

function ok(summary: string, evidence: string[]): WorkerResult {
  return { status: "success", executor: "deterministic", summary, evidence, grokbotRequired: false, costUsd: 0, tokensEstimate: 0 };
}

function tryMath(text: string): WorkerResult | null {
  const expr = extractMathExpr(text);
  if (!expr) return null;
  try {
    const value = evaluate(expr);
    if (value == null) return null;
    return ok(`${expr} = ${value}`, [`deterministic math: ${expr} = ${value}`]);
  } catch {
    return null;
  }
}

/**
 * Extract a candidate arithmetic expression from task text. We scan for the
 * first math-significant character (digit, operator, paren, or function), then
 * greedily collect a run of math characters. The grammar is validated later by
 * evaluate(), which returns null on anything it can't fully consume.
 */
function extractMathExpr(text: string): string | null {
  const fnMatch = text.match(/(?:calculate|compute|what is|evaluate|solve|find)?\s*(sqrt|abs)\(([^()]+)\)/i);
  if (fnMatch) return `${fnMatch[1]!.toLowerCase()}(${fnMatch[2]!.replace(/\s+/g, "")})`;

  const scan = text.search(/[-+*/(%^]|\d/);
  if (scan < 0) return null;
  let candidate = "";
  for (let i = scan; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/[-+*/().%^]|\d/.test(ch)) candidate += ch;
    else break;
  }
  const expr = candidate.replace(/(^\.|\.$)/g, "");
  return expr && /[+\-*/().%^]/.test(expr) && !/^\.\d/.test(expr) ? expr : null;
}

function tryHash(text: string): WorkerResult | null {
  const m = text.match(/(sha256|sha1|md5)\s+of\s+["']?([^"'\n]+)["']?/i);
  if (!m) return null;
  const algo = m[1]!.toLowerCase();
  const target = m[2]!.trim();
  const data = existsSync(pathResolve(target)) ? readFileSync(pathResolve(target)) : Buffer.from(target);
  const hash = createHash(algo).update(data).digest("hex");
  return ok(`${algo} of ${target} = ${hash}`, [`${algo} computed locally`]);
}

function tryCount(text: string): WorkerResult | null {
  const m = text.match(/count (?:the )?(?:number of )?files (?:in |under )?["']?([^"'\n]+)["']?/i);
  if (!m) return null;
  const dir = m[1]!.trim();
  if (!existsSync(pathResolve(dir))) {
    return { status: "failure", executor: "deterministic", summary: `no such directory: ${dir}`, evidence: [], grokbotRequired: false };
  }
  const files = readdirSync(pathResolve(dir));
  return ok(`${dir} contains ${files.length} entries`, [`readdir determined count locally`]);
}

function tryGit(text: string): WorkerResult | null {
  if (!/git (status|rev-parse|log)/i.test(text)) return null;
  if (/git rev-parse HEAD/.test(text)) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return ok(`HEAD = ${head}`, ["git resolved locally"]);
  }
  if (/git status/.test(text)) {
    const out = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const lines = out.split("\n").filter(Boolean);
    const clean = lines.length === 0;
    return ok(clean ? "working tree clean" : `${lines.length} changed path(s)`, [clean ? "git status clean" : out.trim()]);
  }
  return null;
}

/**
 * Safe arithmetic: tokenizer + recursive descent. No eval.
 */
let pos = 0;
let toks: string[] = [];

function tokenize(expr: string): string[] {
  return expr.match(/\d+(\.\d+)?|[+\-*/()^]|sqrt|abs|%/g) ?? [];
}

export function evaluate(expr: string): number | null {
  toks = tokenize(expr);
  pos = 0;
  try {
    const v = exprValue();
    if (pos !== toks.length) return null;
    return v;
  } catch {
    return null;
  }
}

function peek(): string {
  return toks[pos] ?? "";
}

function expect(t: string): void {
  if (peek() !== t) throw new Error(`expected ${t}`);
  pos += 1;
}

function exprValue(): number {
  let v = term();
  while (true) {
    if (peek() === "+") {
      pos += 1;
      v += term();
    } else if (peek() === "-") {
      pos += 1;
      v -= term();
    } else break;
  }
  return v;
}

function term(): number {
  let v = factor();
  while (true) {
    if (peek() === "*") {
      pos += 1;
      v *= factor();
    } else if (peek() === "/") {
      pos += 1;
      const d = factor();
      if (d === 0) throw new Error("divide by zero");
      v /= d;
    } else if (peek() === "%") {
      pos += 1;
      v %= factor();
    } else break;
  }
  return v;
}

function factor(): number {
  let v = power();
  if (peek() === "^") {
    pos += 1;
    const e = factor();
    v = Math.pow(v, e);
  }
  return v;
}

function power(): number {
  const t = peek();
  if (t === "-") {
    pos += 1;
    return -power();
  }
  if (t === "+") {
    pos += 1;
    return power();
  }
  if (t === "(") {
    pos += 1;
    const v = exprValue();
    expect(")");
    return v;
  }
  if (t === "sqrt") {
    pos += 1;
    expect("(");
    const v = exprValue();
    expect(")");
    return Math.sqrt(v);
  }
  if (t === "abs") {
    pos += 1;
    expect("(");
    const v = exprValue();
    expect(")");
    return Math.abs(v);
  }
  if (/^\d/.test(t)) {
    pos += 1;
    return parseFloat(t);
  }
  throw new Error("unexpected token");
}