import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const auth = ctx.session.auth.current;
        const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
        const requestedModel = attributes.model || process.env.CHAT_AGENT_MODEL || "google/gemini-3.5-flash-lite";
        const sessionId = attributes.sessionId;

        // If explicitly prefixed with "openrouter/", route via OpenRouter
        if (requestedModel.startsWith("openrouter/")) {
          const rawId = requestedModel.slice("openrouter/".length);
          const openrouter = createOpenRouter({
            apiKey: process.env.OPENROUTER_API_KEY,
            appName: "TrainerTwin Brain",
            appUrl: "https://chat.trainertwin.com",
            headers: sessionId ? { "x-session-id": sessionId } : undefined,
          });
          return {
            model: openrouter(rawId),
            modelContextWindowTokens: 1_048_576,
          };
        }

        // Native Vercel AI Gateway (0% markup, direct Vertex/Azure peering, 400+ tps)
        return requestedModel;
      },
    },
  }),
  reasoning: "none",
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    sessionTimeoutMs: false,
  },
});
