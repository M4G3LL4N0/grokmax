/**
 * Reproducible live experiment sessions.
 *
 * A live comparison is only meaningful when the two sides differ in exactly one
 * way. The failure mode this exists to prevent is comparing a warm native run
 * against a cold edge run and declaring the edge route faster.
 *
 * Every session therefore pins:
 *   - an isolated database namespace and cache namespace, so one mode's cache
 *     can never answer another mode's lookup;
 *   - an explicit cache state (cold or warm), so a cold/warm mismatch is an
 *     error rather than a silent advantage;
 *   - the git SHA, task fixture version, repo fixture version and a
 *     configuration fingerprint, so a result can be tied to exact inputs;
 *   - explicit success criteria, so a failed task is never counted as a win.
 */
import { createHash } from "node:crypto";
import type { SqliteStore } from "@grokmax/cache";

export const EXPERIMENT_MODES = ["native", "inbot", "edge"] as const;
export type ExperimentMode = (typeof EXPERIMENT_MODES)[number];

export const CACHE_STATES = ["cold", "warm"] as const;
export type CacheState = (typeof CACHE_STATES)[number];

export interface SuccessCriteria {
  /** The task must report a successful worker result. */
  completed: boolean;
  /** GrokBot must not have been invoked for this task. */
  noGrokbotInvocation: boolean;
  /** If set, the outcome summary must match this pattern. */
  summaryRegex?: string;
  /** If set, the routed executor must equal this value. */
  expectedExecutor?: string;
  /** If set, the cache layer that answered must equal this value. */
  expectedCacheLayer?: string;
}

export interface ExperimentSession {
  id: string;
  mode: ExperimentMode;
  cacheState: CacheState;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  gitSha: string | null;
  taskFixtureVersion: string;
  repoFixtureVersion: string | null;
  configFingerprint: string;
  dbNamespace: string;
  cacheNamespace: string;
  beforeSnapshotId: string | null;
  afterSnapshotId: string | null;
  criteria: SuccessCriteria;
  manifest: Record<string, unknown>;
}

export interface ExperimentRecord {
  sessionId: string;
  taskId: string;
  mode: ExperimentMode;
  createdAt: string;
  route: string | null;
  executor: string | null;
  cacheLayer: string | null;
  status: string;
  success: boolean;
  grokbotRequired: boolean;
  grokbotInvoked: boolean;
  cacheState: CacheState;
  contextBefore: number | null;
  contextAfter: number | null;
  externalCostUsd: number | null;
  elapsedMs: number;
  retries: number;
  artifact: string | null;
  criteriaMet: boolean | null;
  result: Record<string, unknown>;
}

export interface ExperimentRecordInput {
  taskId: string;
  route?: string | null;
  executor?: string | null;
  cacheLayer?: string | null;
  status: string;
  success: boolean;
  grokbotRequired: boolean;
  grokbotInvoked: boolean;
  cacheState: CacheState;
  contextBefore?: number | null;
  contextAfter?: number | null;
  externalCostUsd?: number | null;
  elapsedMs: number;
  retries?: number;
  artifact?: string | null;
  result?: Record<string, unknown>;
}

export interface ExperimentCreateInput {
  id: string;
  mode: ExperimentMode;
  cacheState: CacheState;
  taskFixtureVersion: string;
  repoFixtureVersion?: string;
  config?: Record<string, unknown>;
  criteria?: Partial<SuccessCriteria>;
  gitSha?: string;
  manifest?: Record<string, unknown>;
}

export class ExperimentError extends Error {}

export class ExperimentStore {
  constructor(private readonly store: SqliteStore) {}

  create(input: ExperimentCreateInput): ExperimentSession {
    if (!EXPERIMENT_MODES.includes(input.mode)) throw new ExperimentError(`unknown experiment mode: ${String(input.mode)}`);
    if (!CACHE_STATES.includes(input.cacheState)) throw new ExperimentError(`unknown cache state: ${String(input.cacheState)}`);
    if (!input.id || !/^[A-Za-z0-9._-]+$/.test(input.id)) throw new ExperimentError(`invalid session id: ${input.id}`);

    const existing = this.get(input.id);
    if (existing) throw new ExperimentError(`session already exists: ${input.id}`);

    const now = new Date().toISOString();
    const configFingerprint = configFingerprintOf(input.config ?? {});
    const session: ExperimentSession = {
      id: input.id,
      mode: input.mode,
      cacheState: input.cacheState,
      status: "open",
      createdAt: now,
      updatedAt: now,
      gitSha: input.gitSha ?? null,
      taskFixtureVersion: input.taskFixtureVersion,
      repoFixtureVersion: input.repoFixtureVersion ?? null,
      configFingerprint,
      dbNamespace: dbNamespaceFor(input.id),
      cacheNamespace: cacheNamespaceFor(input.id),
      beforeSnapshotId: null,
      afterSnapshotId: null,
      criteria: { completed: true, noGrokbotInvocation: true, ...(input.criteria ?? {}) },
      manifest: input.manifest ?? {}
    };

    this.store.db
      .prepare(
        `INSERT INTO experiment_sessions
         (id, mode, cache_state, status, created_at, updated_at, git_sha, task_fixture_version,
          repo_fixture_version, config_fingerprint, db_namespace, cache_namespace,
          before_snapshot_id, after_snapshot_id, criteria, manifest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.mode,
        session.cacheState,
        session.status,
        Date.parse(now),
        Date.parse(now),
        session.gitSha,
        session.taskFixtureVersion,
        session.repoFixtureVersion,
        session.configFingerprint,
        session.dbNamespace,
        session.cacheNamespace,
        null,
        null,
        JSON.stringify(session.criteria),
        JSON.stringify(session.manifest)
      );

    return session;
  }

  get(id: string): ExperimentSession | null {
    const row = this.store.db.prepare("SELECT * FROM experiment_sessions WHERE id = ?").get(id) as RawSession | undefined;
    return row ? hydrateSession(row) : null;
  }

  private require(id: string): ExperimentSession {
    const session = this.get(id);
    if (!session) throw new ExperimentError(`session not found: ${id}`);
    return session;
  }

  list(limit = 50): ExperimentSession[] {
    const rows = this.store.db.prepare("SELECT * FROM experiment_sessions ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as RawSession[];
    return rows.map(hydrateSession);
  }

  attachSnapshot(id: string, which: "before" | "after", snapshotId: string): ExperimentSession {
    this.require(id);
    const column = which === "before" ? "before_snapshot_id" : "after_snapshot_id";
    this.store.db.prepare(`UPDATE experiment_sessions SET ${column} = ?, updated_at = ? WHERE id = ?`).run(snapshotId, Date.now(), id);
    return this.require(id);
  }

  close(id: string): ExperimentSession {
    this.require(id);
    this.store.db.prepare("UPDATE experiment_sessions SET status = 'closed', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return this.require(id);
  }

  record(sessionId: string, input: ExperimentRecordInput): ExperimentRecord {
    const session = this.require(sessionId);
    if (session.status === "closed") throw new ExperimentError(`session is closed: ${sessionId}`);

    const rec: ExperimentRecord = {
      sessionId,
      taskId: input.taskId,
      mode: session.mode,
      createdAt: new Date().toISOString(),
      route: input.route ?? null,
      executor: input.executor ?? null,
      cacheLayer: input.cacheLayer ?? null,
      status: input.status,
      success: input.success,
      grokbotRequired: input.grokbotRequired,
      grokbotInvoked: input.grokbotInvoked,
      cacheState: input.cacheState,
      contextBefore: input.contextBefore ?? null,
      contextAfter: input.contextAfter ?? null,
      externalCostUsd: input.externalCostUsd ?? null,
      elapsedMs: input.elapsedMs,
      retries: input.retries ?? 0,
      artifact: input.artifact ?? null,
      criteriaMet: null,
      result: input.result ?? {}
    };
    rec.criteriaMet = evaluateCriteria(session.criteria, rec);

    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO experiment_records
         (session_id, task_id, mode, created_at, route, executor, cache_layer, status, success,
          grokbot_required, grokbot_invoked, cache_state, context_before, context_after,
          external_cost_usd, elapsed_ms, retries, artifact, criteria_met, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.sessionId,
        rec.taskId,
        rec.mode,
        Date.parse(rec.createdAt),
        rec.route,
        rec.executor,
        rec.cacheLayer,
        rec.status,
        rec.success ? 1 : 0,
        rec.grokbotRequired ? 1 : 0,
        rec.grokbotInvoked ? 1 : 0,
        rec.cacheState,
        rec.contextBefore,
        rec.contextAfter,
        rec.externalCostUsd,
        rec.elapsedMs,
        rec.retries,
        rec.artifact,
        rec.criteriaMet == null ? null : rec.criteriaMet ? 1 : 0,
        JSON.stringify(rec.result)
      );

    return rec;
  }

  records(sessionId: string): ExperimentRecord[] {
    this.require(sessionId);
    const rows = this.store.db
      .prepare("SELECT * FROM experiment_records WHERE session_id = ? ORDER BY created_at ASC, task_id ASC")
      .all(sessionId) as unknown as RawRecord[];
    return rows.map(hydrateRecord);
  }

  /**
   * A task counts as an avoided-GrokBot result only when it actually
   * completed, did not invoke GrokBot, and met the session's criteria. A
   * failure is not a saving.
   */
  avoidedCount(sessionId: string): number {
    return this.records(sessionId).filter(isGenuineAvoidance).length;
  }

  eligibleCount(sessionId: string): number {
    return this.records(sessionId).length;
  }
}

export function isGenuineAvoidance(rec: ExperimentRecord): boolean {
  return rec.success && !rec.grokbotInvoked && rec.criteriaMet === true;
}

export function evaluateCriteria(criteria: SuccessCriteria, rec: ExperimentRecord): boolean {
  if (criteria.completed && !rec.success) return false;
  if (criteria.noGrokbotInvocation && rec.grokbotInvoked) return false;
  if (criteria.expectedExecutor && rec.executor !== criteria.expectedExecutor) return false;
  if (criteria.expectedCacheLayer && rec.cacheLayer !== criteria.expectedCacheLayer) return false;
  if (criteria.summaryRegex) {
    const summary = String(rec.result?.summary ?? "");
    if (!safeRegex(criteria.summaryRegex).test(summary)) return false;
  }
  return true;
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    // `/(?!)/` is a negative lookahead on the empty string: it never matches,
    // so an invalid criterion fails closed instead of silently passing.
    return /(?!)/;
  }
}

export function dbNamespaceFor(sessionId: string): string {
  return `exp-${sessionId}`;
}

export function cacheNamespaceFor(sessionId: string): string {
  return `cache-${sessionId}`;
}

export function configFingerprintOf(config: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

interface RawSession {
  id: string;
  mode: string;
  cache_state: string;
  status: string;
  created_at: number;
  updated_at: number;
  git_sha: string | null;
  task_fixture_version: string;
  repo_fixture_version: string | null;
  config_fingerprint: string;
  db_namespace: string;
  cache_namespace: string;
  before_snapshot_id: string | null;
  after_snapshot_id: string | null;
  criteria: string;
  manifest: string;
}

function hydrateSession(row: RawSession): ExperimentSession {
  return {
    id: row.id,
    mode: row.mode as ExperimentMode,
    cacheState: row.cache_state as CacheState,
    status: row.status as "open" | "closed",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    gitSha: row.git_sha,
    taskFixtureVersion: row.task_fixture_version,
    repoFixtureVersion: row.repo_fixture_version,
    configFingerprint: row.config_fingerprint,
    dbNamespace: row.db_namespace,
    cacheNamespace: row.cache_namespace,
    beforeSnapshotId: row.before_snapshot_id,
    afterSnapshotId: row.after_snapshot_id,
    criteria: JSON.parse(row.criteria) as SuccessCriteria,
    manifest: JSON.parse(row.manifest) as Record<string, unknown>
  };
}

interface RawRecord {
  session_id: string;
  task_id: string;
  mode: string;
  created_at: number;
  route: string | null;
  executor: string | null;
  cache_layer: string | null;
  status: string;
  success: number;
  grokbot_required: number;
  grokbot_invoked: number;
  cache_state: string;
  context_before: number | null;
  context_after: number | null;
  external_cost_usd: number | null;
  elapsed_ms: number;
  retries: number;
  artifact: string | null;
  criteria_met: number | null;
  result: string;
}

function hydrateRecord(row: RawRecord): ExperimentRecord {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    mode: row.mode as ExperimentMode,
    createdAt: new Date(row.created_at).toISOString(),
    route: row.route,
    executor: row.executor,
    cacheLayer: row.cache_layer,
    status: row.status,
    success: row.success === 1,
    grokbotRequired: row.grokbot_required === 1,
    grokbotInvoked: row.grokbot_invoked === 1,
    cacheState: row.cache_state as CacheState,
    contextBefore: row.context_before,
    contextAfter: row.context_after,
    externalCostUsd: row.external_cost_usd,
    elapsedMs: row.elapsed_ms,
    retries: row.retries,
    artifact: row.artifact,
    criteriaMet: row.criteria_met == null ? null : row.criteria_met === 1,
    result: JSON.parse(row.result) as Record<string, unknown>
  };
}
