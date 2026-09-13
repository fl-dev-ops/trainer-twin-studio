import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent, defineDynamic } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const auth = ctx.session.auth.current;
        const requestedModel =
          (auth?.attributes as Record<string, string> | undefined)?.model ||
          process.env.CHAT_AGENT_MODEL ||
          "openai/gpt-4.1-mini";
        return {
          model: openrouter(requestedModel),
          modelContextWindowTokens: 1_048_576,
        };
      },
    },
  }),
  reasoning: "low",
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    sessionTimeoutMs: false,
  },
});
