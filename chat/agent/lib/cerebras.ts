import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { gateway } from "ai";

/** Cerebras called directly with our own key, not through the gateway: model ids written "cerebras/<id>". */
const cerebras = createOpenAICompatible({
  name: "cerebras",
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: process.env.CEREBRAS_API_KEY,
  includeUsage: true,
  // Cerebras honours response_format json_schema; without this a structured output (Output.object) sends no schema (lib/twin-query.ts).
  supportsStructuredOutputs: true,
});

export const isCerebrasModel = (modelId: string) => modelId.startsWith("cerebras/");

export const cerebrasModel = (modelId: string) => cerebras(modelId.slice("cerebras/".length));

/** Qwen thinks by default (200+ reasoning tokens on a one-line pick, Nov 6); "none" answered in ~0.4 s. */
export const cerebrasProviderOptions = (reasoningEffort?: string) => ({
  cerebras: { reasoningEffort: reasoningEffort || process.env.CEREBRAS_REASONING_EFFORT || "none" },
});

/** "cerebras/<id>" direct, anything else through the gateway. */
export const resolveModel = (modelId: string) => (isCerebrasModel(modelId) ? cerebrasModel(modelId) : gateway(modelId));
