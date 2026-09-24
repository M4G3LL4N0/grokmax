/**
 * Constraint extraction & protection.
 *
 * Hard constraints must survive compilation verbatim. We detect the classes of
 * requirement listed in the project spec and refuse to compress them.
 */

export const HARD_PATTERNS: RegExp[] = [
  /do not (deploy|publish|push|commit|install|run|start|stop|use|modify|touch|remove|delete|change|break|deploy to prod)/i,
  /never (deploy|publish|push|commit|install|run|stop|use|modify|remove|delete|change)/i,
  /must (not|never|use|keep|preserve|maintain|leave)/i,
  /only (use|install|run|test|build)/i, // covers "only use pnpm"
  /\b(pnpm|npm|yarn|bun) only\b/i,
  /\buse (pnpm|npm|yarn|bun)\b/i,
  /requires? (approval|human approval|my approval|sign.?off)/i,
  /needs? (approval|human approval)/i,
  /ask (first|before|me before)/i,
  /confirm before/i,
  /unless (i|i've|approved|you get)/i,
  /with(out|in)? (my|your|a)? ?(approval|permission|signoff)/i,
  /before (deploying|pushing|committing|running|releasing|merging)/i,
  /(under|within|less than|below|at most|max)(\s|$)/i,
  /\$\s?\d/i,
  /until /i,
  /stop (when|after|if|at)/i,
  /halt/i,
  /sandbox\b|no network|offline only/i,
  /do not touch/i,
  /leave .* unchanged/i,
  /keep .* (intact|unchanged|as is)/i,
  /preserve (the )?/i,
  /won'?t (touch|change|modify)/i,
  /strictly (read.?only|no changes)/i,
  /read.?only/i,
  /no (authentication|credentials|secrets)/i,
  /do not (log|print|show|expose|store) (secrets|keys|passwords|tokens)/i,
  /approved( only)?/i,
  /under no circumstances/i
];

export function extractHardConstraints(text: string): string[] {
  const found: string[] = [];
  const lines = text.split(/\n+/);
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line.length < 5) continue;
    if (HARD_PATTERNS.some((p) => p.test(line))) found.push(line);
  }
  return [...new Set(found)];
}

export function extractStopConditions(text: string, constraints: string[]): string[] {
  const stops: string[] = [];
  for (const c of [...constraints, text]) {
    if (/until\b/.test(c)) stops.push(c);
    if (/\bstop (when|after|if|at)\b/.test(c)) stops.push(c);
    if (/\bhalt\b/.test(c)) stops.push(c);
    if (/do not (deploy|publish|push|commit|run)/i.test(c)) stops.push(c);
  }
  return [...new Set(stops)].slice(0, 8);
}

/**
 * Tokens that must never be altered: file paths, URLs, amounts, dates,
 * hashes, env names, CLI flags, identifiers, exact names.
 */
export const PROTECTED_REGEXES: RegExp[] = [
  /^\S*[\\/]\S+$/,
  /^\.[\w-]+$/,
  /^(?:pnpm|npm|yarn|bun|cargo|go|python|node|npx|git|ruby|deno)\b/i,
  /^\d+(\.\d+)?\s*(%|\$|USD|EUR|ms|s|min|hr|h|days?|weeks?|months?|years?|GB|MB|KB|B|x|tokens?|requests?|turns?)\b/i,
  /^\d{4}-\d{2}-\d{2}$/,
  /^https?:\/\/\S+$/i,
  /^[a-f0-9]{40}$/i,
  /^[0-9a-f]{32}$/i,
  /^[A-Z][A-Z0-9_]{2,}$/,
  /^--?[a-z][a-z0-9-]*/i,
  /^v?\d+\.\d+\.\d+.*$/,
  /^[A-Za-z][A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  /\$\d+(\.\d+)?/,
  /^\d+$/,
  /^(grokmax|cursor|xai|openai|anthropic|google|meta|microsoft|apple)\b/i
];

export function isProtected(token: string): boolean {
  if (PROTECTED_REGEXES.some((re) => re.test(token))) return true;
  if (/\d/.test(token)) return true;
  if (token.includes("/") || token.includes("\\") || token.startsWith(".")) return true;
  const upperCount = (token.match(/[A-Z]/g) ?? []).length;
  if (upperCount >= 2) return true;
  return false;
}

export const FILLER_WORDS = new Set([
  "please",
  "kindly",
  "simply",
  "just",
  "really",
  "basically",
  "actually",
  "honestly",
  "totally",
  "very",
  "quite",
  "extremely",
  "definitely",
  "obviously",
  "anyway",
  "fine",
  "okay",
  "whenever",
  "perhaps",
  "maybe"
]);

export function compressWording(text: string): string {
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  let prevWasSpace = true;
  for (const tok of tokens) {
    if (/^\s+$/.test(tok)) {
      out.push(" ");
      prevWasSpace = true;
      continue;
    }
    const word = tok.trim();
    if (FILLER_WORDS.has(word.toLowerCase()) && !prevWasSpace) {
      // Drop a stray filler only when it's not a lone word after punctuation boundary.
      continue;
    }
    out.push(word);
    prevWasSpace = false;
  }
  return out
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

export function collapseRepeatedLines(text: string): string {
  const seen = new Map<string, string>();
  for (const line of text.split("\n")) {
    const norm = line.replace(/\s+/g, " ").trim().toLowerCase();
    if (!norm) continue;
    const key = norm.split(" ").slice(0, 5).join(" ");
    const existing = seen.get(key);
    if (!existing || line.length > existing.length) seen.set(key, line);
  }
  return [...seen.values()].join("\n");
}