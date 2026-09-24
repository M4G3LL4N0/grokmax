/**
 * Generic API adapter: POST the compiled prompt to a configured endpoint.
 * Enabled only when GROKMAX_API_ENDPOINT is set.
 */
import type { CompiledPrompt, GrokMaxTask, WorkerResult } from "@grokmax/core";
import type { Provider } from "@grokmax/providers";

export interface ApiOptions {
  endpoint?: string;
  token?: string;
}

export class ApiProvider implements Provider<ApiOptions> {
  readonly id = "api" as const;

  constructor(private readonly opts: ApiOptions = {}) {}

  private endpoint(): string | undefined {
    return this.opts.endpoint ?? process.env.GROKMAX_API_ENDPOINT ?? undefined;
  }

  detect(): boolean {
    return Boolean(this.endpoint());
  }

  async execute(compiled: CompiledPrompt, task: GrokMaxTask, opts?: ApiOptions): Promise<WorkerResult> {
    const endpoint = opts?.endpoint ?? this.endpoint();
    if (!endpoint) {
      return { status: "failure", executor: "api", summary: "GROKMAX_API_ENDPOINT not set", evidence: [], grokbotRequired: false };
    }
    const token = opts?.token ?? process.env.GROKMAX_API_TOKEN ?? undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: { intent: task.intent, goal: task.goal }, prompt: compiled.prompt })
    });
    if (!res.ok) {
      return { status: "failure", executor: "api", summary: `api error ${res.status}: ${(await res.text()).slice(0, 500)}`, evidence: [], grokbotRequired: false };
    }
    const json = (await res.json()) as Partial<WorkerResult> & { message?: string };
    return {
      status: json.status ?? "success",
      executor: "api",
      summary: json.summary ?? json.message ?? "api completed",
      artifact: json.artifact,
      evidence: json.evidence ?? ["api responded"],
      grokbotRequired: false,
      costUsd: json.costUsd ?? null,
      tokensEstimate: json.tokensEstimate ?? compiled.tokensEstimate,
      rawOutput: json.rawOutput ?? JSON.stringify(json).slice(0, 8000)
    };
  }
}