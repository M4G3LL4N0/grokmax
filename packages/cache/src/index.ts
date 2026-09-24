/**
 * Cache fabric: L0 (hot/coalescing), L1 (exact), L2 (normalized), L3 (semantic)
 * backed by a single SQLite database. Artifacts (L4) and knowledge (L5) live in
 * their own packages against the same store.
 */
import type { CacheItem } from "@grokmax/core";
import type { GrokMaxTask } from "@grokmax/core";
import type { CacheOps } from "@grokmax/core";
import { SqliteStore } from "./db.js";
import { HotCache } from "./hot.js";
import { SemanticCache } from "./semantic.js";
import { computeDependencyFingerprint } from "./deps.js";

export { SqliteStore, openStore } from "./db.js";
export { HotCache } from "./hot.js";
export { SemanticCache, significantTokens, extractCriticalLiterals, criticalLiteralsCompatible } from "./semantic.js";
export { computeDependencyFingerprint, resolveWithin } from "./deps.js";

export class GrokMaxCache implements CacheOps {
  readonly store: SqliteStore;
  private readonly hot: HotCache;
  private readonly semantic: SemanticCache;

  constructor(dbPath?: string, private readonly opts: { cwd?: string; semanticThreshold?: number } = {}) {
    this.store = new SqliteStore(dbPath ?? process.env.GROKMAX_DB ?? defaultDbPath());
    this.hot = new HotCache();
    this.semantic = new SemanticCache(this.store, opts.semanticThreshold);
  }

  close(): void {
    this.store.close();
  }

  dependencyFingerprint(task: GrokMaxTask): string {
    return computeDependencyFingerprint(task, { cwd: this.opts.cwd });
  }

  lookupExact(hash: string): CacheItem | null {
    const hot = this.hot.get(`L1:${hash}`);
    if (hot) {
      if (hot.expiresAt != null && Date.now() > hot.expiresAt) {
        this.hot.delete(`L1:${hash}`);
        this.store.bump("exact_misses");
        return null;
      }
      this.store.bump("exact_hits");
      return hot;
    }
    const row = this.store.db.prepare("SELECT result, expires_at, dep_fingerprint, explanation FROM exact_cache WHERE hash = ?").get(hash) as
      | { result: string; expires_at: number | null; dep_fingerprint: string | null; explanation: string }
      | undefined;
    if (!row) {
      this.store.bump("exact_misses");
      return null;
    }
    if (row.expires_at != null && Date.now() > row.expires_at) {
      this.store.bump("exact_misses");
      return null;
    }
    this.store.bump("exact_hits");
    const item: CacheItem = {
      result: row.result,
      expiresAt: row.expires_at,
      depFingerprint: row.dep_fingerprint,
      explanation: row.explanation
    };
    this.hot.set(`L1:${hash}`, item);
    return item;
  }

  storeExact(hash: string, item: CacheItem): void {
    this.hot.set(`L1:${hash}`, item);
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO exact_cache(hash, result, stored_at, expires_at, dep_fingerprint, explanation)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(hash, item.result, Date.now(), item.expiresAt, item.depFingerprint, item.explanation);
  }

  invalidateExact(hash: string, explanation: string): void {
    this.hot.delete(`L1:${hash}`);
    this.store.db.prepare("DELETE FROM exact_cache WHERE hash = ?").run(hash);
    this.store.db.prepare("INSERT INTO invalidations(hash, at, reason, layer) VALUES (?, ?, ?, ?)").run(hash, Date.now(), explanation, "L1");
  }

  lookupNormalized(hash: string): CacheItem | null {
    const row = this.store.db.prepare("SELECT result, expires_at, dep_fingerprint, explanation FROM normalized_cache WHERE hash = ?").get(hash) as
      | { result: string; expires_at: number | null; dep_fingerprint: string | null; explanation: string }
      | undefined;
    if (!row) return null;
    if (row.expires_at != null && Date.now() > row.expires_at) return null;
    const item: CacheItem = {
      result: row.result,
      expiresAt: row.expires_at,
      depFingerprint: row.dep_fingerprint,
      explanation: row.explanation
    };
    return item;
  }

  storeNormalized(hash: string, item: CacheItem): void {
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO normalized_cache(hash, result, stored_at, expires_at, dep_fingerprint, explanation)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(hash, item.result, Date.now(), item.expiresAt, item.depFingerprint, item.explanation);
  }

  lookupSemantic(intent: string, task: GrokMaxTask, depFp: string): { item: CacheItem; confidence: number } | null {
    return this.semantic.lookup(intent, task, depFp);
  }

  storeSemantic(entries: Array<{ intentHash: string; key: string; item: CacheItem; score: number }>, task: GrokMaxTask): void {
    this.semantic.storeEntries(entries, task);
  }

  async coalesce(hash: string, compute: () => Promise<CacheItem>): Promise<CacheItem> {
    return this.hot.coalesce(hash, compute);
  }

  stats(): { exactHits: number; exactMisses: number; normalizedHits: number; semanticHits: number; semanticMisses: number; coalesced: number; size: number } {
    return {
      exactHits: this.store.stat("exact_hits"),
      exactMisses: this.store.stat("exact_misses"),
      normalizedHits: this.store.stat("normalized_hits"),
      semanticHits: this.store.stat("semantic_hits"),
      semanticMisses: this.store.stat("semantic_misses"),
      coalesced: this.hot.coalescedHits(),
      size: this.hot.size()
    };
  }

  invalidateByPrefix(prefix: string, _explanation: string): number {
    const exact = this.store.db.prepare("DELETE FROM exact_cache WHERE hash LIKE ?").run(`${prefix}%`);
    const norm = this.store.db.prepare("DELETE FROM normalized_cache WHERE hash LIKE ?").run(`${prefix}%`);
    const sem = this.store.db.prepare("DELETE FROM semantic_index WHERE key_hash LIKE ?").run(`${prefix}%`);
    return Number(exact.changes) + Number(norm.changes) + Number(sem.changes);
  }

  prune(): { removed: number; invalidations: number } {
    const now = Date.now();
    const e1 = this.store.db.prepare("DELETE FROM exact_cache WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);
    const e2 = this.store.db.prepare("DELETE FROM normalized_cache WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);
    const e3 = this.semantic.prune();
    const removed = Number(e1.changes) + Number(e2.changes) + e3;
    const inv = this.store.db.prepare("SELECT COUNT(*) AS c FROM invalidations").get() as { c: number };
    return { removed, invalidations: Number(inv.c) };
  }

  invalidations(): Array<{ hash: string; at: number; reason: string; layer: string }> {
    return this.store.db.prepare("SELECT hash, at, reason, layer FROM invalidations ORDER BY at DESC LIMIT 50").all() as Array<{
      hash: string;
      at: number;
      reason: string;
      layer: string;
    }>;
  }

  clearAll(): void {
    this.hot.clear();
    this.store.db.exec("DELETE FROM exact_cache; DELETE FROM normalized_cache; DELETE FROM semantic_index; DELETE FROM invalidations;");
  }
}

function defaultDbPath(): string {
  const root = process.env.GROKMAX_ROOT ?? process.cwd();
  return `${root}/data/grokmax.db`;
}