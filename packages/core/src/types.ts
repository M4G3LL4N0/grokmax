export const PROMPT_VERSION = "grokmax-v0.1.1";

export const FRESHNESS = {
  IMMUTABLE: "immutable",
  SLOW: "slow",
  DAILY: "daily",
  HOURLY: "hourly",
  LIVE: "live",
  NEVER_CACHE: "never-cache"
} as const;

export type Freshness = (typeof FRESHNESS)[keyof typeof FRESHNESS];

export const OUTPUT = {
  ANSWER: "answer",
  ARTIFACT: "artifact",
  ACTION: "action"
} as const;

export type OutputType = (typeof OUTPUT)[keyof typeof OUTPUT];

export const EXECUTOR = {
  AUTO: "auto",
  CODE: "code",
  API: "api",
  CHATGPT: "chatgpt",
  OPENCODE: "opencode",
  GROKBOT: "grokbot"
} as const;

export type Executor = (typeof EXECUTOR)[keyof typeof EXECUTOR];

export const EXECUTION_STATUS = {
  SUCCESS: "success",
  FAILURE: "failure",
  PARTIAL: "partial",
  BLOCKED: "blocked",
  SKIPPED: "skipped"
} as const;

export type ExecutionStatus = (typeof EXECUTION_STATUS)[keyof typeof EXECUTION_STATUS];

export interface GrokMaxTask {
  intent: string;
  goal: string;

  contextRefs?: string[];
  constraints?: string[];

  freshness?:
    | "immutable"
    | "slow"
    | "daily"
    | "hourly"
    | "live"
    | "never-cache";

  output?: "answer" | "artifact" | "action";

  preferredExecutor?:
    | "auto"
    | "code"
    | "api"
    | "chatgpt"
    | "opencode"
    | "grokbot";

  maxCostUsd?: number;
  maxGrokBotUsage?: number;

  requireFresh?: boolean;
}

export type CacheLayer = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

export interface CacheLookup {
  layer: CacheLayer;
  hit: boolean;
  key?: string;
  confidence?: number;
  reason: string;
  expirationMs?: number | null;
  invalidatedBy?: string[];
}

export type RouteValue = "context" | "deterministic" | "api" | "chatgpt" | "opencode" | "grokbot" | "none";

export interface RouteCheck {
  label: string;
  result: boolean;
}

export interface RouteDecision {
  route: RouteValue;
  reason: string;
  grokbotRequired: boolean;
  cache: "hit" | "miss";
  budget: {
    withinUsdBudget: boolean;
    estimatedUsd: number | null;
    maxUsd: number | null;
    withinGrokBotBudget: boolean;
    grokbotUsageEstimate: number;
    maxGrokBotUsage: number | null;
  };
  checks: RouteCheck[];
  cheaperThanDirect: boolean;
}

export interface ContextSlice {
  selected: ContextUnit[];
  excluded: ContextUnit[];
  context_before_bytes: number;
  context_after_bytes: number;
  contextBeforeChars: number;
  contextAfterChars: number;
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  excludedReasons: Record<string, string>;
}

export interface ContextUnit {
  id: string;
  kind: "note" | "file" | "artifact" | "rule" | "history" | "knowledge" | "dependency";
  content: string;
  bytes: number;
  meta?: Record<string, unknown>;
}

export interface CompiledPrompt {
  prompt: string;
  inputChars: number;
  outputChars: number;
  tokensEstimate: number;
  preserved: string[];
  removed: string[];
  validation: {
    ok: boolean;
    issues: string[];
    preservedConstraints: string[];
    lostConstraints: string[];
  };
  stages: Array<{ name: string; beforeChars: number; afterChars: number; note?: string }>;
}

export interface WorkerResult {
  status: ExecutionStatus;
  executor: string;
  summary: string;
  artifact?: string;
  evidence: string[];
  grokbotRequired: boolean;
  costUsd?: number | null;
  tokensEstimate?: number | null;
  rawOutput?: string;
  /** Process exit code when a worker runs a subprocess (e.g. OpenCode). */
  exitCode?: number | null;
  /** Captured stderr for subprocess workers. */
  stderr?: string;
  /** Whether a retry against this executor is likely to succeed. */
  retryEligible?: boolean;
}

export interface LedgerEntry {
  runId: string;
  taskText: string;
  intent: string;
  goal: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  cache: CacheLookup[];
  route: RouteDecision;
  context: ContextSlice | null;
  compiled: CompiledPrompt | null;
  worker: WorkerResult | null;
  retries: number;
  errors: string[];
  humanIntervention: boolean;
  measured: {
    providerCostUsd?: number | null;
    accountUsageBefore?: number | null;
    accountUsageAfter?: number | null;
    grokbotCalls?: number | null;
  };
  status: ExecutionStatus;
}

export interface RunOutcome {
  task: GrokMaxTask;
  cache: CacheLookup[];
  route: RouteDecision;
  context: ContextSlice | null;
  compiled: CompiledPrompt | null;
  worker: WorkerResult | null;
  outcome: WorkerResult;
  explain: string;
  run: LedgerEntry;
}

export const DEFAULT_FRESHNESS: Freshness = "hourly";

export function freshnessTtlMs(f: Freshness): number | null {
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
  }
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}