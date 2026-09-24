/**
 * L4 artifact store with strict scope isolation.
 *
 * Artifacts are addressed as grokmax://artifact/<id>. Lookup is always
 * scoped: an artifact stored under scope "A" can never be read by scope "B",
 * and malformed refs are rejected before any lookup.
 */
import { createHash } from "node:crypto";
import type { SqliteStore } from "@grokmax/cache";

export const ARTIFACT_REF_PREFIX = "grokmax://artifact/";
const ID_RE = /^[a-f0-9]{32}$/;

export interface ArtifactMeta {
  id: string;
  scope: string;
  kind: string;
  hash: string;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

export class ArtifactStore {
  constructor(private readonly store: SqliteStore) {}

  put(kind: string, data: string, scope: string, meta?: Record<string, unknown>): { ref: string; id: string; bytes: number } {
    const id = createHash("sha256").update(`${scope}::${kind}::${data}`).digest("hex").slice(0, 32);
    const hash = createHash("sha256").update(data).digest("hex");
    const bytes = Buffer.byteLength(data);
    const now = Date.now();
    this.store.db
      .prepare(
        `INSERT INTO artifacts(id, scope, kind, data, hash, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, hash = excluded.hash,
           meta = excluded.meta, updated_at = excluded.updated_at`
      )
      .run(id, scope, kind, data, hash, JSON.stringify(meta ?? {}), now, now);
    return { ref: `${ARTIFACT_REF_PREFIX}${id}`, id, bytes };
  }

  get(ref: string, scope: string): { id: string; kind: string; data: string; meta: Record<string, unknown>; bytes: number } | null {
    const id = parseRef(ref);
    if (!id) return null;
    const row = this.store.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | { id: string; scope: string; kind: string; data: string; meta: string; bytes: number; created_at: number }
      | undefined;
    if (!row) return null;
    if (row.scope !== scope) return null;
    return { id: row.id, kind: row.kind, data: row.data, meta: JSON.parse(row.meta ?? "{}") as Record<string, unknown>, bytes: row.bytes };
  }

  getById(id: string, scope: string): { id: string; kind: string; data: string; meta: Record<string, unknown>; bytes: number } | null {
    if (!ID_RE.test(id)) return null;
    const row = this.store.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | { id: string; scope: string; kind: string; data: string; meta: string; bytes: number; created_at: number }
      | undefined;
    if (!row || row.scope !== scope) return null;
    return { id: row.id, kind: row.kind, data: row.data, meta: JSON.parse(row.meta ?? "{}") as Record<string, unknown>, bytes: row.bytes };
  }

  list(scope: string): Array<{ id: string; kind: string; bytes: number; createdAt: number }> {
    return this.store.db.prepare("SELECT id, kind, data, created_at FROM artifacts WHERE scope = ? ORDER BY created_at DESC").all(scope).map((r) => ({
      id: (r as { id: string }).id as string,
      kind: (r as { kind: string }).kind as string,
      bytes: Buffer.byteLength((r as { data: string }).data as string),
      createdAt: (r as { created_at: number }).created_at as number
    }));
  }

  remove(ref: string, scope: string): boolean {
    const id = parseRef(ref);
    if (!id) return false;
    const info = this.store.db.prepare("DELETE FROM artifacts WHERE id = ? AND scope = ?").run(id, scope);
    return Number(info.changes) > 0;
  }

  count(): number {
    const row = this.store.db.prepare("SELECT COUNT(*) AS c FROM artifacts").get() as { c: number };
    return Number(row.c);
  }
}

function parseRef(ref: string): string | null {
  if (typeof ref !== "string") return null;
  if (ref.startsWith(ARTIFACT_REF_PREFIX)) {
    const id = ref.slice(ARTIFACT_REF_PREFIX.length);
    return ID_RE.test(id) ? id : null;
  }
  return null;
}

/**
 * L5 durable compressed knowledge: reusable compact project/task state.
 * Never blinds whole conversations — only compact machine-readable handoffs.
 */
export class KnowledgeStore {
  constructor(private readonly store: SqliteStore) {}

  get(key: string): string | null {
    const row = this.store.db.prepare("SELECT data FROM knowledge WHERE key = ?").get(key) as { data: string } | undefined;
    return row?.data ?? null;
  }

  set(key: string, data: string): void {
    this.store.db.prepare("INSERT OR REPLACE INTO knowledge(key, data, updated_at) VALUES (?, ?, ?)").run(key, data, Date.now());
  }

  delete(key: string): boolean {
    const info = this.store.db.prepare("DELETE FROM knowledge WHERE key = ?").run(key);
    return Number(info.changes) > 0;
  }

  keys(): string[] {
    return this.store.db.prepare("SELECT key FROM knowledge ORDER BY updated_at DESC").all().map((r) => (r as { key: string }).key);
  }
}