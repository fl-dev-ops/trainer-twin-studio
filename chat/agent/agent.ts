import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

export default defineAgent({
  model: openrouter(process.env.CHAT_AGENT_MODEL ?? "openai/gpt-4.1-mini"),
  modelContextWindowTokens: 1_048_576,
  reasoning: "low",
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    sessionTimeoutMs: false,
  },
});
