import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exact_cache (
  hash TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  expires_at INTEGER,
  dep_fingerprint TEXT,
  explanation TEXT,
  kind TEXT
);

CREATE TABLE IF NOT EXISTS normalized_cache (
  hash TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  expires_at INTEGER,
  dep_fingerprint TEXT,
  explanation TEXT
);

CREATE TABLE IF NOT EXISTS semantic_index (
  intent_hash TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  expires_at INTEGER,
  dep_fingerprint TEXT,
  score REAL NOT NULL,
  intent TEXT NOT NULL,
  constraints TEXT NOT NULL,
  freshness TEXT NOT NULL,
  output TEXT NOT NULL,
  executor TEXT NOT NULL,
  PRIMARY KEY (intent_hash, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_semantic_intent ON semantic_index(intent_hash);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  hash TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_scope ON artifacts(scope, kind);

CREATE TABLE IF NOT EXISTS knowledge (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_stats (
  name TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invalidations (
  hash TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  layer TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  run_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    const v = this.db.prepare("PRAGMA user_version;").get() as { user_version: number };
    if ((v.user_version as number) === 0) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
  }

  migrate(): void {
    this.db.exec(SCHEMA);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  bump(name: string, by = 1): void {
    this.db
      .prepare(
        `INSERT INTO cache_stats(name, count) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET count = count + excluded.count`
      )
      .run(name, by);
  }

  stat(name: string): number {
    const row = this.db.prepare("SELECT count FROM cache_stats WHERE name = ?").get(name) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}

export function openStore(dbPath?: string): SqliteStore {
  return new SqliteStore(dbPath ?? process.env.GROKMAX_DB ?? defaultDbPath());
}

function defaultDbPath(): string {
  const root = process.env.GROKMAX_ROOT ?? process.cwd();
  return `${root}/data/grokmax.db`;
}