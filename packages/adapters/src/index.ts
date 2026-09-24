/**
 * Wire up all adapter providers into a single provider registry.
 */
import { SimpleRegistry } from "@grokmax/providers";
import { DeterministicProvider } from "./deterministic.js";
import { OpenCodeProvider, type OpenCodeOptions } from "./opencode.js";
import { ChatGPTProvider, type ChatGPTOptions } from "./chatgpt.js";
import { GrokBotProvider, type GrokBotOptions } from "./grokbot.js";
import { ApiProvider, type ApiOptions } from "./api.js";

export type * from "./deterministic.js";
export type * from "./opencode.js";
export type * from "./chatgpt.js";
export type * from "./grokbot.js";
export type * from "./api.js";
export { DeterministicProvider, evaluate } from "./deterministic.js";
export { OpenCodeProvider, runSpawn, containedOrBase } from "./opencode.js";
export { ChatGPTProvider } from "./chatgpt.js";
export { GrokBotProvider } from "./grokbot.js";
export { ApiProvider } from "./api.js";

export interface RegistryOptions {
  opencode?: OpenCodeOptions;
  chatgpt?: ChatGPTOptions;
  grokbot?: GrokBotOptions;
  api?: ApiOptions;
}

export function createDefaultRegistry(options: RegistryOptions = {}): SimpleRegistry {
  return new SimpleRegistry()
    .add(new DeterministicProvider())
    .add(new OpenCodeProvider(options.opencode))
    .add(new ChatGPTProvider(options.chatgpt))
    .add(new GrokBotProvider(options.grokbot))
    .add(new ApiProvider(options.api));
}