/**
 * Deterministic-first router.
 *
 * Decision order (mission hierarchy):
 *   1. Could deterministic local code solve this?
 *   2. Could a direct API/tool solve this?
 *   3. Does this need reasoning/research (ChatGPT / cheap model)?
 *   4. Does this need repository inspection/modification (OpenCode)?
 *   5. Does it uniquely require GrokBot (persistent computer, authenticated
 *      apps, plugins, routines, persistent context)?
 *
 * Every decision carries a reason, a list of checks, budget enforcement, and a
 * "cheaperThanDirect" estimate. If routing would cost more than direct GrokBot
 * execution, we say so instead of pretending otherwise.
 */
import type { GrokMaxTask, RouteCheck, RouteDecision, RouteValue } from "@grokmax/core";

const DETERMINISTIC_INTENTS = [
  { re: /\b(calculate|compute|math|sum|difference|multiply|divide|percentage|sqrt|factorial)\b/i, kind: "deterministic-math" },
  { re: /\b(sha256|md5|hash|fingerprint)\b.*\b(compute|calculate)\b/i, kind: "deterministic-hash" },
  { re: /\bcount (the )?(number of )?files (in|under)\b/i, kind: "deterministic-file-count" },
  { re: /\bgit (status|rev-parse head|log)\b/i, kind: "deterministic-git" }
];

const REPO_INTENTS = [
  /\b(implement|refactor|refactor?ing|fix|bug|build|compiles?|lint|typecheck|test|tests|repo|repository|file|files|package|module|class|function|dependency|import|export|readme|contribute|open source project)\b/i,
  /\b(code|coding|typescript|javascript|python|source|git|commit|pr|pull request|branch)\b/i
];

const RESEARCH_INTENTS = [
  /\b(research|investigate|find out|what is the latest|current|news|today|web|internet|search|compare|analysis|summarize|explain|why does|how does)\b/i
];

const GROKBOT_UNIQUE_INTENTS = [
  /\b(grok|grokbot)\b/i,
  /\b(persistent context|long.?running task|automation across days)\b/i,
  /\b(routines?|plugins?)\b.*\b(grok|grokbot)\b/i,
  /\b(auth|sign in|login) to (a )?website\b/i,
  /\b(browser|chrome|firefox|safari)\b.*\b(automate|click|fill|login)\b/i,
  /\b(book|schedule|post|send) (a )?(message|tweet|email|meeting)\b/i,
  /\b(handle|manage|monitor) (my )?(inbox|account|subscription|billing)\b/i,
  /\b(download.*resolve.*captcha|unlock|verify.*code)\b/i,
  /\b(do it for me now while i wait|act as my assistant live)\b/i
];

export interface CostModel {
  // Estimated worker-level token consumption per route (measured/estimated, not a claim).
  toks: Record<string, number>;
  // Rough USD per 1k tokens (estimate only).
  usdPer1k: Record<string, number>;
}

const DEFAULT_COST_MODEL: CostModel = {
  toks: { deterministic: 0, api: 1500, chatgpt: 3500, opencode: 12000, grokbot: 20000 },
  usdPer1k: { deterministic: 0, api: 0.01, chatgpt: 0.01, opencode: 0.02, grokbot: 0.05 }
};

export function routeTask(
  task: GrokMaxTask,
  available: Set<string>,
  contextReport: { beforeChars: number; afterChars: number } | null,
  costModel: CostModel = DEFAULT_COST_MODEL
): RouteDecision {
  const checks: RouteCheck[] = [];
  const combined = [task.goal, task.intent, ...(task.constraints ?? [])].join("\n");

  const has = (r: string): boolean => available.has(r);

  const deterministicKind = DETERMINISTIC_INTENTS.find((d) => d.re.test(combined));

  checks.push({ label: "deterministic-local", result: Boolean(deterministicKind) });
  const isRepoWork = REPO_INTENTS.some((re) => re.test(combined)) && !GROKBOT_UNIQUE_INTENTS.some((re) => re.test(combined));
  checks.push({ label: "repository-work", result: isRepoWork });
  const isResearch = RESEARCH_INTENTS.some((re) => re.test(combined));
  checks.push({ label: "research-reasoning", result: isResearch });
  const isGrokUnique = GROKBOT_UNIQUE_INTENTS.some((re) => re.test(combined));
  checks.push({ label: "grokbot-unique-capability", result: isGrokUnique });

  // Explicit executor preference.
  let preferred: RouteValue | null = null;
  if (task.preferredExecutor && task.preferredExecutor !== "auto") {
    const map: Record<string, RouteValue> = {
      code: "deterministic",
      api: "api",
      chatgpt: "chatgpt",
      opencode: "opencode",
      grokbot: "grokbot"
    };
    preferred = map[task.preferredExecutor] ?? null;
    checks.push({ label: `preferred:${task.preferredExecutor}`, result: true });
  }

  let route: RouteValue;
  let reason: string;

  if (preferred) {
    if (has(preferred)) {
      route = preferred;
      reason = `explicit preferredExecutor=${task.preferredExecutor}`;
    } else {
      route = fallbackRoute(task, has, combined, isRepoWork, isGrokUnique, deterministicKind, false);
      reason = `preferredExecutor=${task.preferredExecutor} unavailable; fell back`;
    }
  } else if (deterministicKind) {
    route = "deterministic";
    reason = `${deterministicKind.kind} resolvable locally with zero intelligence cost`;
  } else if (isGrokUnique) {
    route = has("grokbot") ? "grokbot" : fallbackRoute(task, has, combined, isRepoWork, isGrokUnique, deterministicKind, false);
    reason = has("grokbot") ? "task uniquely benefits from GrokBot-specific capabilities" : "GrokBot bridge off; using fallback";
  } else if (isRepoWork) {
    route = has("opencode") ? "opencode" : has("grokbot") ? "grokbot" : "none";
    reason = has("opencode") ? "repository modification/inspection required" : "opencode unavailable";
  } else if (isResearch) {
    route = has("chatgpt") ? "chatgpt" : has("opencode") ? "opencode" : has("grokbot") ? "grokbot" : "none";
    reason = has("chatgpt") ? "reasoning/research best served by ChatGPT-capable worker" : "chatgpt unavailable; using available worker";
  } else {
    route = fallbackRoute(task, has, combined, isRepoWork, isGrokUnique, deterministicKind, false);
    reason = "generic task; chosen cheapest available capable worker";
  }

  if (route === "none") {
    if (task.preferredExecutor === "grokbot" && !has("grokbot")) {
      reason = "grokbot requested but bridge not configured; nothing executable";
    } else if (!task.preferredExecutor) {
      reason = "no capable worker available; nothing executable";
    }
  }

  // Budget enforcement.
  const estimatedUsd = estimateUsd(route, costModel);
  const grokbotUsageEstimate = route === "grokbot" ? 1 : 0;
  const withinUsdBudget = task.maxCostUsd == null || estimatedUsd == null || estimatedUsd <= task.maxCostUsd;
  const withinGrokBotBudget = task.maxGrokBotUsage == null || grokbotUsageEstimate <= task.maxGrokBotUsage;

  let finalRoute = route;
  if (route === "grokbot" && !withinGrokBotBudget) {
    finalRoute = fallbackRoute(task, has, combined, isRepoWork, isGrokUnique, deterministicKind, true) ?? "none";
    reason = `grokbot exceeds maxGrokBotUsage=${task.maxGrokBotUsage}; routed to ${finalRoute}`;
  }
  if (finalRoute !== "none" && task.maxCostUsd != null && (estimateUsd(finalRoute, costModel) ?? Infinity) > task.maxCostUsd) {
    reason = `route ${finalRoute} would exceed maxCostUsd=${task.maxCostUsd}; refusing spend`;
    finalRoute = "none";
  }

  checks.push({ label: "budget-ok", result: withinUsdBudget && withinGrokBotBudget });

  // Would routing cost more than direct GrokBot execution? Estimate only.
  const routedTokens = costModel.toks[finalRoute] ?? costModel.toks.default ?? 0;
  const directTokens = costModel.toks.grokbot ?? 20000;
  const cheaperThanDirect = finalRoute === "deterministic" || finalRoute === "none" || finalRoute === "grokbot" ? true : routedTokens < directTokens;

  return {
    route: finalRoute,
    reason,
    grokbotRequired: finalRoute === "grokbot",
    cache: "miss",
    budget: {
      withinUsdBudget,
      estimatedUsd,
      maxUsd: task.maxCostUsd ?? null,
      withinGrokBotBudget,
      grokbotUsageEstimate,
      maxGrokBotUsage: task.maxGrokBotUsage ?? null
    },
    checks,
    cheaperThanDirect
  };
}

function fallbackRoute(
  task: GrokMaxTask,
  has: (r: string) => boolean,
  combined: string,
  isRepoWork: boolean,
  isGrokUnique: boolean,
  deterministicKind: { re: RegExp; kind: string } | undefined,
  forbidGrokbot = false
): RouteValue {
  if (has("opencode") && (isRepoWork || /code|repo|implement|fix|build|test|file/i.test(combined))) return "opencode";
  if (has("chatgpt") && RESEARCH_INTENTS.some((re) => re.test(combined))) return "chatgpt";
  if (has("deterministic") && deterministicKind) return "deterministic";
  if (has("api")) return "api";
  if (has("opencode")) return "opencode";
  if (has("chatgpt")) return "chatgpt";
  if (!forbidGrokbot && has("grokbot") && isGrokUnique) return "grokbot";
  if (!forbidGrokbot && has("grokbot")) return "grokbot";
  return "none";
}

function estimateUsd(route: RouteValue, model: CostModel): number | null {
  if (route === "none" || route === "deterministic") return 0;
  const toks = model.toks[route] ?? 0;
  const rate = model.usdPer1k[route] ?? 0;
  return (toks / 1000) * rate;
}