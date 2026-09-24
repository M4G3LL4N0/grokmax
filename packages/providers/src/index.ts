/**
 * Provider contracts.
 *
 * Providers must degrade gracefully when unavailable; GrokMax never hard
 * depends on any single provider.
 */
import type { CompiledPrompt, GrokMaxTask, WorkerResult } from "@grokmax/core";

export type RouteName = "deterministic" | "api" | "chatgpt" | "opencode" | "grokbot";

export interface Provider<ROptions = unknown> {
  readonly id: RouteName;
  detect(): boolean;
  execute(compiled: CompiledPrompt, task: GrokMaxTask, opts?: ROptions): Promise<WorkerResult>;
}

export interface ProviderRegistry {
  detectSet(): Set<string>;
  execute(route: string, compiled: CompiledPrompt, task: GrokMaxTask): Promise<WorkerResult>;
  get(id: string): Provider | undefined;
}

export class SimpleRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  add(provider: Provider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  detectSet(): Set<string> {
    const set = new Set<string>();
    for (const [id, p] of this.providers) {
      try {
        if (p.detect()) set.add(id);
      } catch {
        // detection must never crash the router
      }
    }
    if (set.size === 0) set.add("deterministic");
    return set;
  }

  async execute(route: string, compiled: CompiledPrompt, task: GrokMaxTask): Promise<WorkerResult> {
    const provider = this.providers.get(route);
    if (!provider) {
      return {
        status: "failure",
        executor: route,
        summary: `no provider registered for route '${route}'`,
        evidence: [],
        grokbotRequired: false
      };
    }
    if (!provider.detect()) {
      return {
        status: "failure",
        executor: route,
        summary: `provider '${route}' unavailable`,
        evidence: [],
        grokbotRequired: route === "grokbot"
      };
    }
    try {
      return await provider.execute(compiled, task);
    } catch (err) {
      return {
        status: "failure",
        executor: route,
        summary: err instanceof Error ? err.message : String(err),
        evidence: [],
        grokbotRequired: false
      };
    }
  }
}