/**
 * GrokMax orchestration pipeline.
 *
 * TASK -> normalize -> fingerprint -> L0/L1 exact -> L2 normalized -> L3 semantic
 *     -> L4 artifact -> L5 knowledge -> slice context -> compile micro-prompt
 *     -> route -> execute -> compress -> save artifact/cache -> ledger
 */
import {
  EXECUTION_STATUS,
  type CacheLookup,
  type ContextSlice,
  type CompiledPrompt,
  type ContextUnit,
  type GrokMaxTask,
  type LedgerEntry,
  type RouteDecision,
  type RunOutcome,
  type WorkerResult
} from "./types.js";
import { canonicalHash, normalizedHash, sha256 } from "./fingerprint.js";
import { canonicalInput, normalizedKey, normalizeTask } from "./normalize.js";

export interface CacheItem {
  result: string;
  expiresAt: number | null;
  depFingerprint: string | null;
  explanation: string;
}

export interface CacheOps {
  lookupExact(hash: string): CacheItem | null;
  storeExact(hash: string, item: CacheItem): void;
  invalidateExact(hash: string, explanation: string): void;
  lookupNormalized(hash: string): CacheItem | null;
  storeNormalized(hash: string, item: CacheItem): void;
  lookupSemantic(intent: string, task: GrokMaxTask, depFp: string): { item: CacheItem; confidence: number } | null;
  storeSemantic(entries: Array<{ intentHash: string; key: string; item: CacheItem; score: number }>, task: GrokMaxTask): void;
  coalesce(hash: string, compute: () => Promise<CacheItem>): Promise<CacheItem>;
  dependencyFingerprint(task: GrokMaxTask): string;
  stats(): { exactHits: number; exactMisses: number; normalizedHits: number; semanticHits: number; semanticMisses: number };
}

export interface ArtifactOps {
  put(kind: string, data: string, scope: string, meta?: Record<string, unknown>): Promise<{ ref: string; id: string }>;
  get(ref: string, scope: string): Promise<{ id: string; kind: string; data: string; meta: Record<string, unknown> } | null>;
  list(scope: string): Promise<Array<{ id: string; kind: string; size: number; createdAt: string }>>;
}

export interface KnowledgeOps {
  get(key: string): string | null;
  set(key: string, data: string): void;
}

export interface RouterOps {
  route(task: GrokMaxTask, available: Set<string>, contextReport: { beforeChars: number; afterChars: number } | null): RouteDecision;
}

export interface CompilerOps {
  compile(opts: { task: GrokMaxTask; selectedContext: string[]; history?: string[] }): CompiledPrompt;
}

export interface ContextOps {
  slice(task: GrokMaxTask, units: ContextUnit[]): Promise<ContextSlice>;
}

export interface ProviderOps {
  detect(): Set<string>;
  execute(route: string, compiled: CompiledPrompt, task: GrokMaxTask): Promise<WorkerResult>;
  estimateCost(route: string, compiled: CompiledPrompt): { usd: number | null; grokbotUsage: number };
}

export interface LedgerOps {
  record(entry: LedgerEntry): Promise<string> | string;
}

export interface EngineDeps {
  cache: CacheOps;
  artifacts?: ArtifactOps;
  knowledge?: KnowledgeOps;
  router: RouterOps;
  compiler: CompilerOps;
  context: ContextOps;
  providers: ProviderOps;
  ledger: LedgerOps;
  now?: () => Date;
}

export interface RunOptions {
  skipCacheWrite?: boolean;
  history?: string[];
  rawContext?: { id: string; content: string; kind?: string; meta?: Record<string, unknown> }[];
  maxRetries?: number;
  dryRunOnly?: boolean;
}

export class GrokMaxEngine {
  private readonly inflight = new Map<string, Promise<WorkerResult>>();

  constructor(private readonly deps: EngineDeps) {}

  private scopeFor(task: GrokMaxTask): string {
    const ref = (task.contextRefs ?? []).find((r) => r.startsWith("grokmax://") || !r.includes("://"));
    if (ref) return ref.replace(/[/:]/g, "_").slice(0, 64);
    return "default";
  }

  async run(task: GrokMaxTask, opts: RunOptions = {}): Promise<RunOutcome> {
    const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const cacheLookups: CacheLookup[] = [];
    const errors: string[] = [];

    const normalized = normalizeTask(task);
    const canonInput = canonicalInput(task);
    const cHash = canonicalHash(canonInput);
    const nKey = normalizedKey(normalized);
    const nHash = normalizedHash(nKey);
    const depFp = this.deps.cache.dependencyFingerprint(task);

    const missingDeps = (item: CacheItem): string[] => {
      if (!item.depFingerprint) return [];
      return item.depFingerprint === depFp ? [] : ["dependency fingerprint changed"];
    };

    // ---- L0 hot cache / request coalescing + L1 exact ----
    let cached: CacheItem | null = null;
    let hitLayer: string | null = null;
    let hitExplanation = "";

    if (!task.requireFresh && task.freshness !== "never-cache") {
      const exact = this.deps.cache.lookupExact(cHash);
      if (exact) {
        const staleBy = missingDeps(exact);
        if (validationPasses(exact, staleBy)) {
          cached = exact;
          hitLayer = "L1";
          hitExplanation = "exact cache hit (canonical hash)";
          cacheLookups.push({ layer: "L1", hit: true, key: cHash, reason: hitExplanation });
        } else {
          cacheLookups.push({ layer: "L1", hit: false, key: cHash, reason: "exact cache invalidated", invalidatedBy: staleBy });
          this.deps.cache.invalidateExact(cHash, staleBy.join(", "));
        }
      } else {
        cacheLookups.push({ layer: "L1", hit: false, key: cHash, reason: "no exact cache entry" });
      }

      if (!cached) {
        const norm = this.deps.cache.lookupNormalized(nHash);
        if (norm) {
          const staleBy = missingDeps(norm);
          if (validationPasses(norm, staleBy)) {
            cached = norm;
            hitLayer = "L2";
            hitExplanation = "normalized cache hit (representation-normalized key)";
            cacheLookups.push({ layer: "L2", hit: true, key: nHash, reason: hitExplanation });
          } else {
            cacheLookups.push({ layer: "L2", hit: false, key: nHash, reason: "normalized cache invalidated", invalidatedBy: staleBy });
          }
        } else {
          cacheLookups.push({ layer: "L2", hit: false, key: nHash, reason: "no normalized cache entry" });
        }
      }

      if (!cached) {
        const sem = this.deps.cache.lookupSemantic(normalized.intent, task, depFp);
        if (sem && validationPasses(sem.item, missingDeps(sem.item))) {
          cached = sem.item;
          hitLayer = "L3";
          hitExplanation = `semantic cache hit (confidence ${sem.confidence.toFixed(3)})`;
          cacheLookups.push({ layer: "L3", hit: true, key: nHash, confidence: sem.confidence, reason: hitExplanation });
        } else {
          cacheLookups.push({
            layer: "L3",
            hit: false,
            key: nHash,
            reason: sem ? "semantic candidate rejected (expired/invalidated)" : "no semantic candidate"
          });
        }
      }
    }

    // ---- L4 artifact reuse: task explicitly references a saved artifact ----
    const artifactRef = (task.contextRefs ?? []).find((r) => r.startsWith("grokmax://artifact/"));
    if (!cached && artifactRef && this.deps.artifacts && task.output !== "action") {
      const scope = this.scopeFor(task);
      const art = await this.deps.artifacts.get(artifactRef, scope);
      if (art) {
        try {
          const parsed = JSON.parse(art.data) as Partial<WorkerResult>;
          cached = { result: JSON.stringify(parsed), expiresAt: null, depFingerprint: null, explanation: `artifact reuse ${artifactRef}` };
          hitLayer = "L4";
          hitExplanation = `reusable artifact ${artifactRef}`;
          cacheLookups.push({ layer: "L4", hit: true, key: artifactRef, reason: hitExplanation });
        } catch {
          cacheLookups.push({ layer: "L4", hit: false, key: artifactRef, reason: "artifact is not a machine-readable WorkerResult" });
        }
      } else {
        cacheLookups.push({ layer: "L4", hit: false, key: artifactRef, reason: "artifact not found in scope" });
      }
    }

    // ---- L5 durable compressed knowledge ----
    if (!cached && this.deps.knowledge && task.freshness === "immutable") {
      const k = this.deps.knowledge.get(cHash);
      if (k) {
        try {
          const parsed = JSON.parse(k) as Partial<WorkerResult>;
          cached = { result: JSON.stringify(parsed), expiresAt: null, depFingerprint: null, explanation: "durable knowledge hit" };
          hitLayer = "L5";
          hitExplanation = "durable compressed knowledge hit";
          cacheLookups.push({ layer: "L5", hit: true, key: cHash, reason: hitExplanation });
        } catch {
          cacheLookups.push({ layer: "L5", hit: false, key: cHash, reason: "knowledge entry unparseable" });
        }
      }
    }

    let worker: WorkerResult | null = null;
    let context: ContextSlice | null = null;
    let compiled: CompiledPrompt | null = null;
    let route!: RouteDecision;
    let final: WorkerResult;

    if (cached) {
      cacheLookups.unshift({ layer: "L0", hit: true, reason: "request satisfied from cache (L0 coalescing / hot cache path)" });
      final = { ...JSON.parse(cached.result) as WorkerResult, status: EXECUTION_STATUS.SUCCESS };
      route = {
        route: "none",
        reason: `cache hit: ${hitExplanation}`,
        grokbotRequired: false,
        cache: "hit",
        budget: { withinUsdBudget: true, estimatedUsd: 0, maxUsd: task.maxCostUsd ?? null, withinGrokBotBudget: true, grokbotUsageEstimate: 0, maxGrokBotUsage: task.maxGrokBotUsage ?? null },
        checks: [{ label: "cache", result: true }],
        cheaperThanDirect: true
      };
    } else {
      cacheLookups.unshift({ layer: "L0", hit: false, reason: "no in-flight/coalesced duplicate; miss" });

      // ---- context slicing ----
      const units: ContextUnit[] = (opts.rawContext ?? []).map((c) => ({
        id: c.id,
        kind: (c.kind as ContextUnit["kind"]) ?? "note",
        content: c.content,
        bytes: Buffer.byteLength(c.content),
        meta: c.meta
      }));
      context = await this.deps.context.slice(task, units);

      // ---- micro-prompt compilation ----
      const compiledPrompt = this.deps.compiler.compile({
        task,
        selectedContext: context.selected.map((u) => u.content),
        history: opts.history
      });
      compiled = compiledPrompt;

      // ---- routing ----
      const available = this.deps.providers.detect();
      route = this.deps.router.route(
        task,
        available,
        { beforeChars: (context?.contextBeforeChars ?? 0), afterChars: (context?.contextAfterChars ?? 0) }
      );

      if (opts.dryRunOnly) {
        final = {
          status: EXECUTION_STATUS.SKIPPED,
          executor: "dry-run",
          summary: "Dry run only; no work executed.",
          evidence: [],
          grokbotRequired: false
        };
      } else {
        // ---- execute with duplicate in-flight suppression ----
        const executor = route.route === "none" ? task.preferredExecutor ?? "auto" : route.route;
        const inflightKey = `${cHash}:${executor}`;
        const compute = async (): Promise<WorkerResult> => {
          let attempt = 0;
          const maxAttempts = (opts.maxRetries ?? 0) + 1;
          let last: WorkerResult = { status: EXECUTION_STATUS.FAILURE, executor, summary: "no attempts", evidence: [], grokbotRequired: false };
          while (attempt < maxAttempts) {
            try {
              const w = await this.deps.providers.execute(executor, compiledPrompt, task);
              if (w.status === "failure" && attempt + 1 < maxAttempts) {
                attempt += 1;
                errors.push(`executor ${executor} failure on attempt ${attempt}: ${w.summary}`);
                last = w;
                continue;
              }
              return w;
            } catch (err) {
              attempt += 1;
              last = { status: EXECUTION_STATUS.FAILURE, executor, summary: errOrMsg(err), evidence: [], grokbotRequired: false };
              if (attempt < maxAttempts) {
                errors.push(`executor ${executor} threw on attempt ${attempt}: ${errOrMsg(err)}`);
                continue;
              }
              return last;
            }
          }
          return last;
        };
        const pending = this.inflight.get(inflightKey);
        if (pending) {
          worker = await pending;
        } else {
          const p = compute().finally(() => this.inflight.delete(inflightKey));
          this.inflight.set(inflightKey, p);
          worker = await p;
        }
        final = worker;
      }

      // ---- save reusable outputs ----
      if (final.status === "success" && !opts.skipCacheWrite && !opts.dryRunOnly && task.freshness !== "never-cache") {
        const resultJson = JSON.stringify(final);
        const item: CacheItem = { result: resultJson, expiresAt: ttlExpiry(task), depFingerprint: depFp, explanation: `stored after ${executorRoute(final, route)}` };
        if (!task.requireFresh && task.freshness !== "live") {
          this.deps.cache.storeExact(cHash, item);
          this.deps.cache.storeNormalized(nHash, item);
          this.deps.cache.storeSemantic([
            { intentHash: sha256(normalized.intent.toLowerCase()), key: nHash, item, score: 1.0 }
          ], task);
        }
        if (task.output === "artifact" && this.deps.artifacts) {
          const { ref } = await this.deps.artifacts.put("worker-result", resultJson, this.scopeFor(task), {
            intent: task.intent
          });
          final = { ...final, artifact: ref };
        }
        if (this.deps.knowledge && task.freshness === "immutable") {
          this.deps.knowledge.set(cHash, JSON.stringify(final));
        }
      }
    }

    // ---- ledger ----
    const elapsedMs = Date.now() - Date.parse(startedAt);
    const compiled4Ledger: CompiledPrompt | null = compiled;
    const context4Ledger: ContextSlice | null = context;

    const runId = sha256(`${startedAt}:${cHash}`).slice(0, 16);
    const entry: LedgerEntry = {
      runId,
      taskText: canonicalInput(task),
      intent: normalized.intent.slice(0, 400),
      goal: normalized.goal.slice(0, 400),
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs,
      cache: cacheLookups,
      route,
      context: context4Ledger,
      compiled: compiled4Ledger,
      worker,
      retries: errors.length,
      errors,
      humanIntervention: false,
      measured: {},
      status: final.status
    };
    this.deps.ledger.record(entry);

    return {
      task,
      cache: cacheLookups,
      route,
      context,
      compiled,
      worker,
      outcome: final,
      explain: buildExplain(route, cacheLookups, hitLayer, hitExplanation),
      run: entry
    };
  }
}

function validationPasses(item: CacheItem, staleBy: string[]): boolean {
  if (staleBy.length > 0) return false;
  if (item.expiresAt != null && Date.now() > item.expiresAt) return false;
  return true;
}

function ttlExpiry(task: GrokMaxTask): number | null {
  const ms = expiryForFreshness(task.freshness ?? "hourly");
  return ms == null ? null : Date.now() + ms;
}

function expiryForFreshness(f: string): number | null {
  switch (f) {
    case "immutable":
      return null;
    case "slow":
      return 7 * 24 * 60 * 60 * 1000;
    case "daily":
      return 24 * 60 * 60 * 1000;
    case "hourly":
      return 60 * 60 * 1000;
    case "live":
      return 5 * 60 * 1000;
    case "never-cache":
      return 0;
    default:
      return 60 * 60 * 1000;
  }
}

function executorRoute(final: WorkerResult, route: RouteDecision): string {
  if (route && route.route !== "none") return route.route;
  return final.executor;
}

function errOrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildExplain(route: RouteDecision, lookups: CacheLookup[], hitLayer: string | null, reason: string): string {
  const lines: string[] = [];
  lines.push(`GrokMax Plan`);
  lines.push(`CACHE   ${hitLayer ? `${hitLayer} HIT — ${reason}` : "miss"}`);
  lines.push(`ROUTE   ${route.route.toUpperCase()}`);
  lines.push(`REASON  ${route.reason}`);
  lines.push(`GROKBOT ${route.grokbotRequired ? "REQUIRED" : "not required"}`);
  return lines.join("\n");
}