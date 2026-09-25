/**
 * Benchmark manifests and contamination guards.
 *
 * The most flattering way to lie about a routing benchmark is to compare a warm
 * native run against a cold edge run. This module makes that mistake hard to
 * commit: a run declares its manifest up front, and the guard refuses to
 * compare two manifests whose cache state, mode, or fixture versions differ.
 *
 * The manifest also pins the repo fixture version, so a coding benchmark can be
 * run against a disposable fixture repository rather than a developer's working
 * tree — otherwise one mode's edits help the next mode.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export const BENCHMARK_MODES = ["native", "inbot", "edge"] as const;
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];

export const CACHE_STATES = ["cold", "warm"] as const;
export type CacheState = (typeof CACHE_STATES)[number];

/** Which class of capability the task is meant to exercise. */
export const CAPABILITY_CLASSES = ["deterministic", "reasoning", "repository", "browser", "cache"] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

export interface BenchmarkManifest {
  name: string;
  version: string;
  mode: BenchmarkMode;
  cacheState: CacheState;
  /** Namespace that must be unique per mode/state so caches cannot bleed. */
  cacheNamespace: string;
  /** What must happen to the cache before the run. */
  stateReset: "fresh-namespace" | "prune" | "none";
  taskFixtureVersion: string;
  repoFixtureVersion: string | null;
  /** Directory of a disposable fixture repo, for coding tasks. */
  repoFixturePath?: string | null;
  gitSha: string | null;
  capabilityClass: CapabilityClass;
  /** True when a cold run must not see anything a prior mode wrote. */
  isolated: boolean;
}

export class ManifestError extends Error {}

export interface ComparisonVerdict {
  comparable: boolean;
  reason: string;
  differences: string[];
}

/**
 * Build a manifest with a namespace derived from its own contents, so two
 * manifests that differ in any meaningful way cannot silently share a cache.
 */
export function buildManifest(input: Omit<BenchmarkManifest, "cacheNamespace" | "isolated"> & { cacheNamespace?: string }): BenchmarkManifest {
  const base = {
    ...input,
    isolated: input.stateReset === "fresh-namespace" || input.cacheState === "cold"
  };
  const ns = input.cacheNamespace ?? namespaceFor(base);
  return { ...base, cacheNamespace: ns };
}

export function namespaceFor(m: Omit<BenchmarkManifest, "cacheNamespace" | "isolated"> | BenchmarkManifest): string {
  const material = [m.name, m.version, m.mode, m.cacheState, m.stateReset, m.taskFixtureVersion, m.repoFixtureVersion ?? "-", m.repoFixturePath ?? "-", m.capabilityClass].join("|");
  return `bm-${createHash("sha256").update(material).digest("hex").slice(0, 12)}`;
}

/**
 * Two runs may only be compared when they differ in the thing under test and
 * nothing else. A cold/warm mismatch is contamination, not a result.
 */
export function compareManifests(a: BenchmarkManifest, b: BenchmarkManifest): ComparisonVerdict {
  const differences: string[] = [];
  if (a.cacheState !== b.cacheState) differences.push(`cache state: ${a.cacheState} vs ${b.cacheState}`);
  if (a.mode !== b.mode) differences.push(`mode: ${a.mode} vs ${b.mode}`);
  if (a.taskFixtureVersion !== b.taskFixtureVersion) differences.push(`task fixtures: ${a.taskFixtureVersion} vs ${b.taskFixtureVersion}`);
  if (a.repoFixtureVersion !== b.repoFixtureVersion) differences.push(`repo fixtures: ${a.repoFixtureVersion} vs ${b.repoFixtureVersion}`);
  if (a.capabilityClass !== b.capabilityClass) differences.push(`capability class: ${a.capabilityClass} vs ${b.capabilityClass}`);
  if (a.version !== b.version) differences.push(`suite version: ${a.version} vs ${b.version}`);

  if (differences.length === 0) {
    return { comparable: true, reason: "manifests differ only in cache namespace, which is the intended isolation", differences };
  }

  // A mode difference is expected when comparing modes. A cold/warm difference
  // is never acceptable, because it changes what the cache is allowed to do.
  const fatal = differences.filter((d) => !d.startsWith("mode:"));
  if (fatal.length > 0) {
    return { comparable: false, reason: `runs are not comparable: ${fatal.join("; ")}`, differences };
  }
  return { comparable: true, reason: "modes differ as intended and all other inputs match", differences };
}

/**
 * Fail a run that claims to be cold but reuses a namespace that already exists
 * on disk. This is the concrete protection against "warm native vs cold edge".
 */
export function assertColdStateHonest(manifest: BenchmarkManifest, namespaceExists: boolean): void {
  if (manifest.cacheState !== "cold") return;
  if (manifest.stateReset !== "fresh-namespace") {
    throw new ManifestError(`cold run ${manifest.name} must declare stateReset="fresh-namespace", got "${manifest.stateReset}"`);
  }
  if (namespaceExists) {
    throw new ManifestError(`cold run ${manifest.name} reused existing cache namespace ${manifest.cacheNamespace}; a cold run must start from an empty namespace`);
  }
}

/** A coding task must run against a disposable fixture, never a live worktree. */
export function assertRepoFixtureSafe(manifest: BenchmarkManifest): void {
  if (manifest.capabilityClass !== "repository") return;
  if (!manifest.repoFixturePath) throw new ManifestError(`repository task ${manifest.name} must set repoFixturePath`);
  if (!existsSync(manifest.repoFixturePath)) throw new ManifestError(`repo fixture does not exist: ${manifest.repoFixturePath}`);
  // A fixture is disposable by construction. Anything that sits inside a real
  // git worktree is a developer's tree, and a benchmark must never mutate it.
  if (!manifest.repoFixturePath.split(/[\\/]/).includes("fixtures")) {
    throw new ManifestError(
      `repository task ${manifest.name} must point at a disposable fixture under a "fixtures" directory, got ${manifest.repoFixturePath}; running a coding benchmark against a live worktree is not allowed`
    );
  }
}

export function describeManifest(m: BenchmarkManifest): string {
  return [
    `manifest  ${m.name}@${m.version}`,
    `  mode:            ${m.mode}`,
    `  cache state:     ${m.cacheState} (reset: ${m.stateReset})`,
    `  cache namespace: ${m.cacheNamespace}`,
    `  task fixtures:   ${m.taskFixtureVersion}`,
    `  repo fixtures:   ${m.repoFixtureVersion ?? "-"}${m.repoFixturePath ? ` (${m.repoFixturePath})` : ""}`,
    `  capability:      ${m.capabilityClass}`,
    `  isolated:        ${m.isolated}`
  ].join("\n");
}
