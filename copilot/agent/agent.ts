import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

export default defineAgent({
  defaultTools: false,
  model: openrouter(process.env.SPEC_COPILOT_MODEL ?? "google/gemini-2.5-pro"),
  modelContextWindowTokens: 1_048_576,
  reasoning: "low",
  limits: {
    sessionUsage: ({ window }) =>
      window.inputTokens - window.cacheReadTokens >= 300_000 ||
      window.outputTokens >= 30_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  },
});
