/**
 * L3 semantic cache.
 *
 * Conservative reuse. A semantic hit is valid only when ALL of these hold:
 *   compatible intent (high significant-token overlap)
 *   compatible constraints (identical constraint set)
 *   compatible freshness (stored freshness is at least as fresh as requested)
 *   compatible required output type (identical)
 *   compatible dependencies (dependency fingerprint unchanged)
 *   confidence above threshold
 *   no explicit requireFresh
 *   identical ordered numeric/amount/operator literals and negation tokens
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

const STOP = new Set([
  "please", "the", "and", "with", "for", "you", "your", "this", "that", "can", "could", "would",
  "give", "need", "want", "should", "from", "into", "about", "where", "when", "what", "have",
  "been", "will", "are", "was", "were", "does"
]);

/** Contractions fold to the negation they express. Distinct negations stay distinct. */
const NEGATION_CANON: Readonly<Record<string, string>> = {
  dont: "not",
  cant: "not",
  wont: "not",
  isnt: "not",
  arent: "not",
  wasnt: "not",
  werent: "not",
  hasnt: "not",
  havent: "not",
  hadnt: "not",
  shouldnt: "not",
  wouldnt: "not",
  couldnt: "not",
  mustnt: "not",
  didnt: "not",
  doesnt: "not",
  cannot: "not",
  not: "not",
  never: "never",
  neither: "neither",
  nobody: "nobody",
  nothing: "nothing",
  nowhere: "nowhere",
  without: "without",
  none: "none",
  nor: "nor",
  no: "no"
};

interface IntentMarks {
  tokens: string[];
  literals: string[];
  negations: string[];
}

export function significantTokens(text: string): string[] {
  return analyzeIntent(text).tokens;
}

/**
 * Ordered numeric/amount/operator literals and negation tokens.
 * Both sequences must be identical for an L3 hit.
 */
function safetyKey(marks: IntentMarks): string {
  return `${marks.literals.join("\u001f")}\u001e${marks.negations.join("\u001f")}`;
}

function analyzeIntent(text: string): IntentMarks {
  const folded = normalizeWhitespace(text.toLowerCase().replace(/[’']/g, ""));
  const literals: string[] = [];
  const shielded = folded.replace(literalPattern(), (raw) => {
    literals.push(canonLiteral(raw));
    return ` gmlit${literals.length - 1} `;
  });

  const negations: string[] = [];
  for (const match of folded.matchAll(negationPattern())) {
    const word = match[1];
    if (!word) continue;
    negations.push(NEGATION_CANON[word] ?? word);
  }

  const tokens: string[] = [];
  for (const part of shielded.split(/\s+/)) {
    if (!part) continue;
    const lit = /^gmlit(\d+)$/.exec(part);
    if (lit) {
      const value = literals[Number(lit[1])];
      if (value) tokens.push(value);
      continue;
    }
    const negation = NEGATION_CANON[part];
    if (negation) {
      tokens.push(negation);
      continue;
    }
    if (part.length <= 2 || STOP.has(part)) continue;
    tokens.push(part);
  }

  return { tokens: [...new Set(tokens)], literals, negations };
}

function literalPattern(): RegExp {
  // Currency amounts, percents, and math expressions. Operators stay attached
  // so `7*8`, `50+1`, and `500+1` are different keys, as are `$50` and `$500`.
  return /(?<![\p{L}\d])(?:[$€£¥]\s*)?[+-]?\d+(?:[.,]\d+)*(?:\s*%|(?:\s*[*/=^×÷+-]\s*(?:[$€£¥]\s*)?[+-]?\d+(?:[.,]\d+)*(?:\s*%)?)*)*/gu;
}

function canonLiteral(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/,/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
}

function negationPattern(): RegExp {
  return /\b(dont|cant|wont|cannot|isnt|arent|wasnt|werent|hasnt|havent|hadnt|shouldnt|wouldnt|couldnt|mustnt|didnt|doesnt|never|neither|nobody|nothing|nowhere|without|none|nor|not|no)\b/g;
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

    const current = analyzeIntent(intent);
    const currentKey = safetyKey(current);
    const currentConstraints = new Set<string>((task.constraints ?? []).map(normalizeWhitespace));
    const currentOutput = task.output ?? "answer";

    let best: SemanticEntry | null = null;
    for (const row of candidates) {
      const stored = analyzeIntent(row.intent);
      const conf = jaccard(stored.tokens, current.tokens);
      if (conf < this.threshold) continue;
      // Refuse the hit when numbers, operators, amounts, or negations differ,
      // even if the remaining words are identical.
      if (safetyKey(stored) !== currentKey) continue;

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