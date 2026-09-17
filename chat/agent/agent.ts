import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent, defineDynamic } from "eve";
import type { AgentModelOptionsDefinition } from "eve";

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
        // Pin google/* models to the Google provider — Vertex routes are ~2x
        // slower on tok/s — and cap thinking: Gemini 3.x burns ~700-800
        // thought tokens (13s TTFT) even on simple turns unless budgeted.
        // Agent-level `reasoning` must stay unset for google/* because the AI
        // SDK forbids combining it with thinkingConfig ("only one of thinking
        // budget and thinking level").
        let options: AgentModelOptionsDefinition | undefined;
        if (requestedModel.startsWith("google/")) {
          options = {
            providerOptions: {
              gateway: { only: ["google"] },
              google: { thinkingConfig: { thinkingBudget: 512 } },
            },
          };
        } else if (requestedModel.startsWith("openai/gpt-5")) {
          // OpenAI 5.x reasoning models: minimal effort caps hidden thinking.
          // (gpt-5-mini rejects "none"; newer gens accept it but "minimal" is
          // valid across the family and near-free.)
          // Azure BYOK: if AZURE_OPENAI_* env is set, requests bill against the
          // Azure subscription instead of gateway credits.
          const azureKey = process.env.AZURE_OPENAI_API_KEY;
          const azureResource = process.env.AZURE_OPENAI_RESOURCE;
          const providerOptions: AgentModelOptionsDefinition["providerOptions"] = {
            openai: { reasoningEffort: "minimal" },
          };
          if (azureKey && azureResource) {
            providerOptions!.gateway = { byok: { azure: [{ apiKey: azureKey, resourceName: azureResource }] } };
          }
          options = { providerOptions };
        }
        if (options) return { model: requestedModel, modelOptions: options };
        return requestedModel;
      },
    },
  }),
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    sessionTimeoutMs: false,
  },
});
