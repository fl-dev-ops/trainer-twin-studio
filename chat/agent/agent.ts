import { defineAgent, defineDynamic } from "eve";
import type { AgentModelOptionsDefinition } from "eve";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const auth = ctx.session.auth.current;
        const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
        const requestedModel = attributes.model || process.env.CHAT_AGENT_MODEL || "google/gemini-3.5-flash-lite";

        // All models route through the Vercel AI Gateway with provider-specific options.
        let options: AgentModelOptionsDefinition | undefined;
        if (requestedModel.startsWith("google/")) {
          options = {
            providerOptions: {
              gateway: { only: ["google"] },
              google: { thinkingConfig: { thinkingBudget: 512 } },
            },
          };
        } else if (requestedModel.startsWith("openai/gpt-5")) {
          const supportsNone = /gpt-5\.[4-9]/.test(requestedModel);
          const azureKey = process.env.AZURE_OPENAI_API_KEY;
          const azureResource = process.env.AZURE_OPENAI_RESOURCE;
          const providerOptions: AgentModelOptionsDefinition["providerOptions"] = {
            openai: { reasoningEffort: supportsNone ? "none" : "minimal" },
          };
          if (azureKey && azureResource) {
            providerOptions!.gateway = { byok: { azure: [{ apiKey: azureKey, resourceName: azureResource }] } };
          }
          options = { providerOptions };
        } else if (requestedModel === "alibaba/qwen3.8-27b") {
          options = { providerOptions: { gateway: { only: ["cerebras"] } } };
        } else if (requestedModel.startsWith("deepseek/")) {
          options = { providerOptions: { gateway: { only: ["deepinfra"] } } };
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
