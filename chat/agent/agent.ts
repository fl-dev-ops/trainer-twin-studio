import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const auth = ctx.session.auth.current;
        const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
        const requestedModel = attributes.model || process.env.CHAT_AGENT_MODEL || "openai/gpt-4.1-mini";
        const sessionId = attributes.sessionId;

        // Pass session identity to OpenRouter for provider sticky routing (keeps KV cache warm)
        const openrouter = createOpenRouter({
          apiKey: process.env.OPENROUTER_API_KEY,
          appName: "TrainerTwin Brain",
          appUrl: "https://chat.trainertwin.com",
          headers: sessionId ? { "x-session-id": sessionId } : undefined,
        });

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
