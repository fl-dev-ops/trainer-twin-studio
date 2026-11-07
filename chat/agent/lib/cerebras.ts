import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { gateway } from "ai";

/** Cerebras called directly with our own key, not through the gateway: model ids written "cerebras/<id>". */
const cerebras = createOpenAICompatible({
  name: "cerebras",
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: process.env.CEREBRAS_API_KEY,
  includeUsage: true,
  // Cerebras honours response_format json_schema; without this generateObject sends no schema (lib/twin-query.ts).
  supportsStructuredOutputs: true,
});

/**
 * The chat agent's model for every turn and the twin-lines query: Qwen on Cerebras, direct. Locked: neither
 * CHAT_AGENT_MODEL nor a per-request model changes it. It reads images; PDFs come as their text (the studio's
 * resolveUpload for this channel).
 */
export const CHAT_MODEL = "cerebras/qwen-3.8-27b";

export const isCerebrasModel = (modelId: string) => modelId.startsWith("cerebras/");

export const cerebrasModel = (modelId: string) => cerebras(modelId.slice("cerebras/".length));

/** Qwen thinks by default (200+ reasoning tokens on a one-line pick, Nov 6); "none" answered in ~0.4 s. */
export const cerebrasProviderOptions = (reasoningEffort?: string) => ({
  cerebras: { reasoningEffort: reasoningEffort || process.env.CEREBRAS_REASONING_EFFORT || "none" },
});

/** "cerebras/<id>" direct, anything else through the gateway. */
export const resolveModel = (modelId: string) => (isCerebrasModel(modelId) ? cerebrasModel(modelId) : gateway(modelId));
