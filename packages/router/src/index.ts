/**
 * Deterministic-first router.
 *
 * The cache layers (exact L1, normalized L2, semantic L3, artifact L4,
 * knowledge L5) are consulted by the pipeline BEFORE routing. For everything
 * that misses cache, the decision order (mission hierarchy) is:
 *   1. Explicit `preferredExecutor` override (documented exception).
 *   2. Deterministic local execution (math/hash/file-count/git) — zero cost.
 *   3. Generic local DB/API/tool for mechanical tasks that need no reasoning
 *      and no repository access.
 *   4. Reasoning / research / planning / compression / adjudication
 *      (ChatGPT, the advisory worker). ChatGPT is preferred here, and when it
 *      is not configured the router degrades to another capable worker rather
 *      than requiring a paid API or escalating to GrokBot.
 *   5. Repository inspection/modification (OpenCode).
 *   6. Grok-Bot — ONLY when uniquely required (persistent computer,
 *      authenticated apps, plugins, routines, persistent context) and no
 *      lower-cost worker is capable.
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

/**
 * Advisory work: reasoning, planning, design, review, compression and
 * adjudication that needs a language model but not repository mutation and not
 * an authenticated browser. This is ChatGPT's lane — it is the preferred
 * worker for turning a vague request into a plan, not for doing the work.
 */
const ADVISORY_INTENTS = [
  /\b(plan|planning|roadmap|design|architect|architecture|strategy|approach|proposal|trade-?offs?|options?|decide|decide between|recommend|adjudicate|review|critique|evaluate|assess|rank|score|prioriti[sz]e)\b/i,
  /\b(compress|summari[sz]e for|tl;?dr|condense|distil|distill|extract key|action items|next steps)\b/i,
  /\b(what should i|should we|is it better|which approach|help me decide)\b/i
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
  const isAdvisory = ADVISORY_INTENTS.some((re) => re.test(combined)) && !isRepoWork && !isGrokUnique;
  checks.push({ label: "advisory-reasoning", result: isAdvisory });

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
    // Step 2: deterministic local execution.
    route = "deterministic";
    reason = `${deterministicKind.kind} resolvable locally with zero intelligence cost`;
  } else if (!isRepoWork && !isResearch && !isAdvisory && !isGrokUnique) {
    // Step 3: generic local DB/API/tool work (mechanical, no reasoning needed).
    if (has("api")) {
      route = "api";
      reason = "generic mechanical task; local API/tool is the cheapest capable worker";
    } else {
      route = fallbackRoute(task, has, combined, isRepoWork, isGrokUnique, deterministicKind, false);
      reason = "generic task; chosen cheapest available capable worker";
    }
  } else if ((isResearch || isAdvisory) && !isRepoWork) {
    // Step 4: reasoning / research / planning / compression / adjudication.
    // ChatGPT is the preferred advisory worker. When it is not configured we
    // degrade to whatever capable worker exists rather than requiring a paid
    // API or escalating to GrokBot.
    if (has("chatgpt")) {
      route = "chatgpt";
      reason = isAdvisory
        ? `advisory work (${matchLabel(ADVISORY_INTENTS, combined)}) best served by the ChatGPT reasoning worker`
        : "reasoning/research best served by ChatGPT-capable worker";
    } else {
      route = has("opencode") ? "opencode" : has("api") ? "api" : has("grokbot") ? "grokbot" : "none";
      reason = isAdvisory
        ? `advisory work detected but ChatGPT is not configured; degrading to ${route}`
        : `chatgpt unavailable; using available worker`;
    }
  } else if (isRepoWork) {
    // Step 5: repository inspection/modification.
    route = has("opencode") ? "opencode" : has("chatgpt") ? "chatgpt" : has("grokbot") ? "grokbot" : "none";
    reason = has("opencode") ? "repository modification/inspection required" : "opencode unavailable";
  } else if (isGrokUnique) {
    // Step 6: Grok-Bot only when uniquely required and nothing else can do it.
    route = has("grokbot") ? "grokbot" : fallbackRoute(task, has, combined, isRepoWork, isGrokUnique, deterministicKind, false);
    reason = has("grokbot") ? "task uniquely benefits from GrokBot-specific capabilities" : "GrokBot bridge off; using fallback";
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
  // Fallback follows the same mission hierarchy: deterministic (2) → generic
  // API (3) → reasoning (4) → repository (5) → GrokBot (6, last resort).
  if (has("deterministic") && deterministicKind) return "deterministic";
  if (has("api")) return "api";
  if (has("chatgpt") && (RESEARCH_INTENTS.some((re) => re.test(combined)) || ADVISORY_INTENTS.some((re) => re.test(combined)))) return "chatgpt";
  if (has("opencode") && (isRepoWork || /code|repo|implement|fix|build|test|file/i.test(combined))) return "opencode";
  if (has("opencode")) return "opencode";
  if (has("chatgpt")) return "chatgpt";
  if (!forbidGrokbot && has("grokbot") && isGrokUnique) return "grokbot";
  if (!forbidGrokbot && has("grokbot")) return "grokbot";
  return "none";
}

/** Human-readable label for whichever advisory pattern fired, for the reason string. */
function matchLabel(patterns: RegExp[], text: string): string {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[0]) return m[0].toLowerCase();
  }
  return "advisory";
}

function estimateUsd(route: RouteValue, model: CostModel): number | null {
  if (route === "none" || route === "deterministic") return 0;
  const toks = model.toks[route] ?? 0;
  const rate = model.usdPer1k[route] ?? 0;
  return (toks / 1000) * rate;
}