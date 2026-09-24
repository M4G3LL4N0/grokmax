/**
 * ChatGPT adapter (OpenAI-compatible API). Only activates when a key is
 * present; GrokMax degrades gracefully without one.
 */
import type { CompiledPrompt, GrokMaxTask, WorkerResult } from "@grokmax/core";
import type { Provider } from "@grokmax/providers";

export interface ChatGPTOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";

export class ChatGPTProvider implements Provider<ChatGPTOptions> {
  readonly id = "chatgpt" as const;

  constructor(private readonly opts: ChatGPTOptions = {}) {}

  private key(): string | undefined {
    return this.opts.apiKey ?? process.env.GROKMAX_CHATGPT_API_KEY ?? undefined;
  }

  detect(): boolean {
    return Boolean(this.key());
  }

  async execute(compiled: CompiledPrompt, task: GrokMaxTask, opts?: ChatGPTOptions): Promise<WorkerResult> {
    const apiKey = this.key();
    if (!apiKey) {
      return {
        status: "failure",
        executor: "chatgpt",
        summary: "GROKMAX_CHATGPT_API_KEY not set; ChatGPT provider unavailable",
        evidence: [],
        grokbotRequired: false
      };
    }
    const base = opts?.baseUrl ?? this.opts.baseUrl ?? "https://api.openai.com/v1";
    const model = opts?.model ?? this.opts.model ?? DEFAULT_MODEL;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are a capable, concise worker. Follow the task and the output format exactly. Never fabricate evidence." },
          { role: "user", content: compiled.prompt }
        ]
      })
    });
    if (!res.ok) {
      return {
        status: "failure",
        executor: "chatgpt",
        summary: `chatgpt API error ${res.status}: ${(await res.text()).slice(0, 500)}`,
        evidence: [],
        grokbotRequired: false
      };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = tryWorkerJson(content);
    const usage = json.usage;
    let costUsd: number | null = null;
    if (usage?.prompt_tokens != null && usage.completion_tokens != null) {
      costUsd = (usage.prompt_tokens / 1e6) * 0.15 + (usage.completion_tokens / 1e6) * 0.6; // provider-reported tokens, public pricing estimate
    }
    if (parsed) {
      return {
        status: parsed.status ?? "success",
        executor: "chatgpt",
        summary: parsed.summary ?? content.slice(0, 2000),
        artifact: parsed.artifact,
        evidence: parsed.evidence ?? ["chatgpt completed"],
        grokbotRequired: parsed.grokbotRequired ?? false,
        costUsd: costUsd ?? parsed.costUsd ?? null,
        tokensEstimate: usage?.prompt_tokens ?? compiled.tokensEstimate,
        rawOutput: content.slice(0, 8000)
      };
    }
    return {
      status: "success",
      executor: "chatgpt",
      summary: content.slice(0, 2000),
      evidence: usage ? [`provider-measured tokens: ${usage.prompt_tokens}+${usage.completion_tokens}`] : [],
      grokbotRequired: false,
      costUsd,
      tokensEstimate: usage?.prompt_tokens ?? compiled.tokensEstimate,
      rawOutput: content.slice(0, 8000)
    };
  }
}

function tryWorkerJson(content: string): Partial<WorkerResult> | null {
  try {
    const p = JSON.parse(content) as Partial<WorkerResult>;
    if (typeof p === "object" && p !== null) return p;
  } catch {
    // fall through
  }
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]) as Partial<WorkerResult>;
    } catch {
      return null;
    }
  }
  return null;
}