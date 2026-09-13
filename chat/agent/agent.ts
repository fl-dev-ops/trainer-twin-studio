import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

export default defineAgent({
  model: openrouter(process.env.CHAT_AGENT_MODEL ?? "openai/gpt-4.1-mini"),
  modelContextWindowTokens: 1_048_576,
  reasoning: "low",
  limits: {
    maxInputTokensPerSession: 300_000,
    maxOutputTokensPerSession: 30_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  },
});
