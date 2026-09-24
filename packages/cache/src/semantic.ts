/**
 * L3 semantic cache.
 *
 * Conservative reuse. A semantic hit is valid only when ALL of these hold:
 *   compatible intent (high significant-token overlap)
 *   compatible critical literals (numbers, math shapes, negation words,
 *     paths, versions, urls, hashes, identifiers, keyword-value pairs are
 *     compared exactly, never fuzzed away)
 *   compatible constraints (identical constraint set)
 *   compatible freshness (stored freshness is at least as fresh as requested)
 *   compatible required output type (identical)
 *   compatible dependencies (dependency fingerprint unchanged)
 *   confidence above threshold
 *   no explicit requireFresh
 *   identical ordered numeric/amount/operator literals and negation tokens
 *
 * The literal gate is fail-closed: two intents that differ in any critical
 * literal NEVER match, regardless of how high raw token overlap is. Without
 * this, token stripping removed numbers and negation words, so
 * "Calculate 50+1" and "Calculate 500+1" both shrunk to ["calculate"] and
 * reported Jaccard 1.0.
 *
 * The intent_hash is used only for deduplication (PRIMARY KEY). Similarity is
 * computed over recently-stored entries by significant-token Jaccard, so near
 * but not identical wording can still reuse a cached answer. Numerals, math
 * operators, currency amounts, and negation tokens stay in that key. A hit is
 * refused when those sequences differ, even if the remaining words would clear
 * the Jaccard threshold. False negatives are preferable to dangerous false positives.
 */
import { sha256 } from "@grokmax/core";
import type { GrokMaxTask } from "@grokmax/core";
import type { CacheItem } from "@grokmax/core";
import { normalizeWhitespace } from "@grokmax/core";
import type { SqliteStore } from "./db.js";

export type SemanticEntry = { item: CacheItem; confidence: number };

interface SemanticRow {
  key_hash: string;
  result: string;
  stored_at: number;
  expires_at: number | null;
  dep_fingerprint: string | null;
  score: number;
  intent: string;
  constraints: string;
  freshness: string;
  output: string;
  executor: string;
}

const DEFAULT_SEMANTIC_THRESHOLD = 0.85;
const SCAN_WINDOW = 2000;

/**
 * Math/currency/percent literals are shielded from punctuation stripping and
 * re-inserted as tokens, so `7*8`, `50+1`, `$50` and `$500` stay distinct in
 * the token set itself rather than collapsing into bare words.
 */
const LITERAL_TOKEN = /(?<![\p{L}\p{N}_.$%-])(?:[$€£¥]\s?)?[-+]?\d+(?:[.,]\d+)*(?:\s?%)?(?:\s*(?:[*/^×÷]|\+|-)\s*(?:[$€£¥]\s?)?[-+]?\d+(?:[.,]\d+)*(?:\s?%)?)*/gu;

/**
 * Contractions and multi-word negations fold to the single negation they
 * express, so "Don't deploy" and "Do not deploy" share a token while neither
 * collapses into the positive "Deploy".
 */
const NEGATION_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdo(?:es)?n[’']t\b/g, "not"],
  [/\b(?:is|are|was|were|has|have|had|should|would|could|will|must|can|wan|wan'?t|need|need'?t|ought)(?:n[’']t)\b/g, "not"],
  [/\bcannot\b/g, "not"],
  [/\bdo not\b/g, "not"],
  [/\bmust not\b/g, "not"],
  [/\bshould not\b/g, "not"],
  [/\bwill not\b/g, "not"],
  [/\bwould not\b/g, "not"],
  [/\bcould not\b/g, "not"],
  [/\bno longer\b/g, "not"],
  [/\bno more\b/g, "not"],
  [/\bnever\b/g, "never"],
  [/\bwithout\b/g, "without"],
  [/\bunless\b/g, "unless"],
  [/\bnor\b/g, "nor"],
  [/\bnot\b/g, "not"]
];

export function significantTokens(text: string): string[] {
  const literals: string[] = [];
  let base = normalizeWhitespace(text.toLowerCase());
  for (const [pattern, canon] of NEGATION_FOLD) base = base.replace(pattern, ` ${canon} `);
  const shielded = base.replace(LITERAL_TOKEN, (raw) => {
    const canon = raw.replace(/\s+/g, "");
    if (canon.length > 1) literals.push(canon);
    return ` gmlit${literals.length - 1} `;
  });
  const clean = shielded
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Negation/modal words stay significant (never stop-listed) so wording like
  // "deploy" vs "do not deploy" is not collapsed into the same token set.
  const stop = new Set(["please", "the", "and", "with", "for", "you", "your", "this", "that", "can", "could", "would", "give", "need", "want", "should", "from", "into", "about", "where", "when", "what", "have", "been", "will", "are", "was", "were", "does"]);
  const tokens: string[] = [];
  for (const part of clean) {
    const lit = /^gmlit(\d+)$/.exec(part);
    if (lit) {
      tokens.push(literals[Number(lit[1])] as string);
      continue;
    }
    if (stop.has(part) || /^\d{1,2}$/.test(part)) continue;
    tokens.push(part);
  }
  return [...new Set(tokens)];
}

/**
 * Critical literals that must match EXACTLY between a stored intent and the
 * current request for a semantic hit to be safe. Each category is a sorted,
 * deduped multiset of canonical strings; ANY category mismatch fails the gate.
 *
 * We deliberately err on the side of extraction: a spurious literal only
 * produces a false negative (allowed), never a false positive.
 */
export interface CriticalLiterals {
  numbers: string[];
  mathShapes: string[];
  currencies: string[];
  percents: string[];
  units: string[];
  negation: string[];
  modality: string[];
  paths: string[];
  dotted: string[];
  versions: string[];
  urls: string[];
  hashes: string[];
  identifiers: string[];
  keywords: string[];
}

const VALUE_STOP = new Set(["not", "no", "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "at", "is", "are", "was", "were", "be", "with", "from", "by", "it", "its", "this", "that", "do", "does", "did", "will"]);
const KEYWORDS = ["branch", "repo", "repository", "version", "file", "filename", "dir", "directory", "path", "package", "port", "endpoint", "url", "env", "var", "token", "secret", "model", "engine", "runtime", "db", "database", "sha256", "sha1", "md5"];
const NEGATION_WORDS = ["not", "never", "no", "without", "unless", "cannot", "won't", "don't", "can't", "isn't", "aren't", "doesn't", "didn't", "must not", "do not", "should not", "no longer", "no more"];
const MODALITY_WORDS = ["only", "exactly", "must", "should", "before", "after", "until", "always", "at least", "at most"];

export function extractCriticalLiterals(text: string): CriticalLiterals {
  const s = normalizeWhitespace(text);
  const low = s.toLowerCase();

  // Numbers: plain integers/floats (with sign), not preceded by letter/digit/_.-$
  const numbers: string[] = [];
  const numRe = /(?<![\p{L}\p{N}_.$%-])([-+]?\d+(?:\.\d+)?)(?![\p{L}\w])/gu;
  for (const m of s.matchAll(numRe)) numbers.push(m[1] as string);

  // Currency amounts: $-prefixed decimals
  const currencies: string[] = [];
  const curRe = /\$\s?(\d+(?:\.\d+)?)/gi;
  for (const m of s.matchAll(curRe)) currencies.push(`$${m[1]}`);

  // Percentages
  const percents: string[] = [];
  const pctRe = /(\d+(?:\.\d+)?)\s?%/gi;
  for (const m of s.matchAll(pctRe)) percents.push(`${m[1]}%`);

  // Numbered units (sizes, durations, quantities)
  const units: string[] = [];
  const unitRe = /(?<![\p{L}\p{N}_.$%-])(\d+(?:\.\d+)?)\s?(GB|MB|KB|B|ms|s|min|hr|h|day|days|week|weeks|month|months|year|years|token|tokens|x|turns?|requests?|times?)/giu;
  for (const m of s.matchAll(unitRe)) units.push(`${m[1]}|${(m[2] as string).toLowerCase()}`);

  // Math expression shapes: operand-operator chains with literals replaced by N.
  const mathShapes: string[] = [];
  const exprRe = /[-+]?\d+(?:\.\d+)?(?:\s*(?:[+\-*/%^])\s*[-+]?\d+(?:\.\d+)?)+/g;
  for (const m of s.matchAll(exprRe)) {
    const shape = (m[0] as string)
      .replace(/\s+/g, "")
      .replace(/(\*\*|[+\-*/%^]{1,2})/g, "|$1|")
      .replace(/\d+(?:\.\d+)?/g, "N")
      .replace(/\|/g, "");
    if (shape.length >= 3) mathShapes.push(shape);
  }

  // Negation and modality words
  const negation = NEGATION_WORDS.filter((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(low));
  const modality = MODALITY_WORDS.filter((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(low));

  // Paths (slash or backslash), dotted names, versions, urls, hashes
  const paths: string[] = [];
  const dotted: string[] = [];
  const versions: string[] = [];
  const urls: string[] = [];
  const hashes: string[] = [];
  for (const tok of s.split(/\s+/)) {
    const t = tok.trim();
    if (!t || /^[.,;:!?]+$/.test(t)) continue;
    if (/[\\/]/.test(t)) {
      paths.push(t.toLowerCase());
    } else if (/^https?:\/\//i.test(t)) {
      urls.push(t.toLowerCase());
    } else if (/^[0-9a-f]{32}$/i.test(t) || /^[a-f0-9]{40}$/i.test(t)) {
      hashes.push(t.toLowerCase());
    } else if (isVersion(t)) {
      versions.push(t.toLowerCase());
    } else if (/\d+\.\d+/.test(t) && /[A-Za-z_]/.test(t)) {
      dotted.push(t.toLowerCase());
    }
  }

  // Identifiers: camel/pascal/snake/acronym tokens or letter+digit mixes.
  // A plain capitalized word ("Calculate") is NOT an identifier — only tokens
  // with internal casing transitions, ALL-CAPS acronyms, or mixed letter+digit.
  const identifiers: string[] = [];
  for (const tok of s.split(/\s+/)) {
    const w = tok.replace(/[^\p{L}\p{N}_]/gu, "");
    if (w.length < 2) continue;
    const letters = (w.match(/\p{L}/gu) ?? []).length;
    const digits = (w.match(/\p{N}/gu) ?? []).length;
    const mixedCase = /[\p{Ll}]\p{Lu}/u.test(w) || /^\p{Lu}\p{Ll}+\p{Lu}/u.test(w);
    const acronym = /^\p{Lu}{2,}$/u.test(w);
    if ((letters > 0 && digits > 0) || mixedCase || acronym) identifiers.push(w.toLowerCase());
  }

  // Keyword-value pairs: branch main, version 1.3.0, sha256 of hello, ...
  const keywords: string[] = [];
  const TRAILING_STOP = new Set(["at", "to", "for", "of", "from", "in", "on", "with", "by", "and", "or", "the", "a", "an", "is", "are", "was", "were", "be"]);
  const kwRe = new RegExp(`\\b(${KEYWORDS.join("|")})\\b(?:\\s+(?:name|of|to|for|is|:))?\\s+([^\\s,;\\n]+(?:\\s+[^\\s,;\\n]+){0,1})`, "gi");
  for (const m of low.matchAll(kwRe)) {
    const key = m[1] as string;
    let val = (m[2] as string).trim().replace(/[.,;!?]+$/, "").trim();
    const words = val.split(/\s+/);
    while (words.length > 1 && TRAILING_STOP.has(words[words.length - 1] as string)) words.pop();
    val = words.join(" ");
    if (!val) continue;
    if (VALUE_STOP.has(val) || (/^\d+$/.test(val) && !["port", "version"].includes(key))) continue;
    if (val.length > 80) continue;
    keywords.push(`${key}:${val}`);
  }

  return { numbers: dedupeSort(numbers), mathShapes: dedupeSort(mathShapes), currencies: dedupeSort(currencies), percents: dedupeSort(percents), units: dedupeSort(units), negation: dedupeSort(negation), modality: dedupeSort(modality), paths: dedupeSort(paths), dotted: dedupeSort(dotted), versions: dedupeSort(versions), urls: dedupeSort(urls), hashes: dedupeSort(hashes), identifiers: dedupeSort(identifiers), keywords: dedupeSort(keywords) };
}

export function criticalLiteralsCompatible(a: string, b: string): boolean {
  const A = extractCriticalLiterals(a);
  const B = extractCriticalLiterals(b);
  return (
    sameList(A.numbers, B.numbers) &&
    sameList(A.mathShapes, B.mathShapes) &&
    sameList(A.currencies, B.currencies) &&
    sameList(A.percents, B.percents) &&
    sameList(A.units, B.units) &&
    sameList(A.negation, B.negation) &&
    sameList(A.modality, B.modality) &&
    sameList(A.paths, B.paths) &&
    sameList(A.dotted, B.dotted) &&
    sameList(A.versions, B.versions) &&
    sameList(A.urls, B.urls) &&
    sameList(A.hashes, B.hashes) &&
    sameList(A.identifiers, B.identifiers) &&
    sameList(A.keywords, B.keywords)
  );
}

function isVersion(t: string): boolean {
  return /^\d+\.\d+\.\d+([-+.]?[\w]+)?$/.test(t);
}

function escapeRe(w: string): string {
  return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeSort(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export class SemanticCache {
  constructor(
    private readonly store: SqliteStore,
    private readonly threshold = DEFAULT_SEMANTIC_THRESHOLD
  ) {}

  storeEntries(entries: Array<{ intentHash: string; key: string; item: CacheItem; score: number }>, task: GrokMaxTask): void {
    const stmt = this.store.db.prepare(
      `INSERT OR REPLACE INTO semantic_index
       (intent_hash, key_hash, result, stored_at, expires_at, dep_fingerprint, score, intent, constraints, freshness, output, executor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of entries) {
      const expires = e.item.expiresAt == null ? null : e.item.expiresAt;
      stmt.run(
        e.intentHash,
        e.key,
        e.item.result,
        Date.now(),
        expires,
        e.item.depFingerprint,
        e.score,
        // Store the actual normalized intent text (never the cache explanation)
        // so fuzzy similarity is computed over what the user actually asked.
        normalizeWhitespace(task.intent).slice(0, 2000),
        JSON.stringify([...(task.constraints ?? [])]),
        task.freshness ?? "hourly",
        task.output ?? "answer",
        task.preferredExecutor ?? "auto"
      );
    }
  }

  lookup(intent: string, task: GrokMaxTask, currentDepFp: string): SemanticEntry | null {
    if (task.requireFresh) return null;
    if (task.freshness === "live" || task.freshness === "never-cache") return null;

    const candidates = this.store.db
      .prepare("SELECT * FROM semantic_index ORDER BY stored_at DESC LIMIT ?")
      .all(SCAN_WINDOW) as unknown as SemanticRow[];

    const currentTokens = significantTokens(intent);
    const currentConstraints = new Set<string>((task.constraints ?? []).map(normalizeWhitespace));
    const currentOutput = task.output ?? "answer";

    let best: SemanticEntry | null = null;
    for (const row of candidates) {
      const storedTokens = significantTokens(row.intent);
      const conf = jaccard(storedTokens, currentTokens);
      if (conf < this.threshold) continue;

      // Fail-closed literal gate: any critical-literal mismatch (numbers,
      // operators/math shape, negation words, paths, versions, identifiers,
      // keyword-value pairs, ...) is rejected regardless of similarity.
      if (!criticalLiteralsCompatible(row.intent, intent)) continue;

      if (row.expires_at != null && Date.now() > row.expires_at) {
        this.store.bump("semantic_expired");
        continue;
      }

      const storedConstraints = new Set<string>((JSON.parse(row.constraints) as string[]).map(normalizeWhitespace));
      if (!sameSet(currentConstraints, storedConstraints)) continue;

      if (row.output !== currentOutput) continue;

      if (!freshnessCompatible(row.freshness, task.freshness ?? "hourly")) continue;

      if (task.preferredExecutor && row.executor && task.preferredExecutor !== row.executor) continue;

      if (row.dep_fingerprint && row.dep_fingerprint !== currentDepFp) continue;

      const item: CacheItem = {
        result: row.result,
        expiresAt: row.expires_at == null ? null : row.expires_at,
        depFingerprint: row.dep_fingerprint,
        explanation: `semantic cache hit matching intent '${row.intent.slice(0, 120)}'`
      };
      if (!best || conf > best.confidence) {
        best = { item, confidence: conf };
      }
    }

    if (best) this.store.bump("semantic_hits");
    return best;
  }

  prune(): number {
    const info = this.store.db.prepare("DELETE FROM semantic_index WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now());
    return Number(info.changes);
  }
}

export { sha256 };

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function freshnessCompatible(stored: string, requested: string): boolean {
  const rank: Record<string, number> = { live: 5, hourly: 4, daily: 3, slow: 2, immutable: 1 };
  const s = rank[stored] ?? 0;
  const r = rank[requested] ?? 0;
  return s >= r;
}