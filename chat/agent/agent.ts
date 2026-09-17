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

        // Native Vercel AI Gateway (0% markup, direct peering, 400+ tps).
        // Pin google/* models to the Google provider (Vertex is ~2x slower on
        // tok/s) and cap Gemini 3.x thinking, which otherwise burns ~1k tokens
        // and 1-8s of TTFT even on simple prompts. Other providers: default
        // routing so failover keeps working.
        if (requestedModel.startsWith("google/")) {
          return {
            model: requestedModel,
            modelOptions: {
              providerOptions: {
                gateway: { only: ["google"] },
                google: { thinkingConfig: { thinkingBudget: 512 } },
              },
            },
          };
        }
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
