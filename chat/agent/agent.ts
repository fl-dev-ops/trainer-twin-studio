import { gateway, wrapLanguageModel } from "ai";
import { defineAgent, defineDynamic } from "eve";
import type { AgentModelOptionsDefinition } from "eve";
import { hedgedStreamMiddleware, routeTo } from "./lib/hedge";
import { thinkingBudgetSchema } from "./lib/thinking-budget";

const PRIMARY_ROUTE = process.env.GEMINI_GATEWAY_PROVIDER?.trim() || "google";
/**
 * Backup route for stalled calls. Defaults to the SAME backend: Gemini 3 thought signatures are
 * backend-bound, and a cross-route backup broke a session ("Invalid thought signature", plan reset).
 */
const BACKUP_ROUTE = process.env.GEMINI_HEDGE_BACKUP_ROUTE?.trim() || PRIMARY_ROUTE;
/** Off unless set (ms). It didn't help in heavy-thinking windows; see plans/voice-latency-optimization.md. */
const HEDGE_AFTER_MS = Number(process.env.GEMINI_HEDGE_AFTER_MS ?? 0);

function geminiModel(modelId: string) {
  if (!(HEDGE_AFTER_MS > 0)) return modelId;
  return wrapLanguageModel({
    model: gateway(modelId),
    middleware: hedgedStreamMiddleware({
      afterMs: HEDGE_AFTER_MS,
      backupParams: routeTo(BACKUP_ROUTE),
      onSettled: (event) => {
        if (event.hedged) console.info("[hedge] " + JSON.stringify({ model: modelId, primary: PRIMARY_ROUTE, backup: BACKUP_ROUTE, afterMs: HEDGE_AFTER_MS, ...event }));
      },
    }),
  });
}

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const auth = ctx.session.auth.current;
        const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
        const requestedModel = attributes.model || process.env.CHAT_AGENT_MODEL || "google/gemini-3.5-flash-lite";

        // All models route through the Vercel AI Gateway with provider-specific options.
        let options: AgentModelOptionsDefinition | undefined;
        if (requestedModel.startsWith("google/")) {
          const rawBudget = attributes.thinkingBudget ?? process.env.GEMINI_THINKING_BUDGET;
          const baseBudget = rawBudget !== undefined ? thinkingBudgetSchema.parse(rawBudget) : undefined;
          const messages = (ctx as any)?.messages ?? [];
          const isToolFollowup = Array.isArray(messages) && messages.length > 0 && messages[messages.length - 1]?.role === "tool";
          const isAsymmetric = attributes.asymmetricThinking === "1" || process.env.ASYMMETRIC_THINKING === "1";
          const budget = baseBudget !== undefined && isToolFollowup && isAsymmetric ? 0 : baseBudget;
          // Gemini 3.x ignores thinkingBudget in practice (budget 0 still thought on 21/30 calls) but
          // honours thinkingLevel; "low" halved average thinking and cut calls over 5 s from 9/30 to 4/30.
          // An explicit budget (header/env) still wins so budget experiments keep working.
          const thinkingLevel = attributes.thinkingLevel || process.env.GEMINI_THINKING_LEVEL || "low";
          const thinkingConfig: Record<string, string | number> = budget !== undefined ? { thinkingBudget: budget } : { thinkingLevel };
          options = {
            providerOptions: {
              // GEMINI_GATEWAY_PROVIDER picks the Google backend: "google" (AI Studio, default) or "vertex".
              gateway: { only: [PRIMARY_ROUTE] },
              google: { thinkingConfig },
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
        } else if (requestedModel === "openai/gpt-oss-120b") {
          options = { providerOptions: { gateway: { only: ["groq"] } } };
        } else if (requestedModel.startsWith("deepseek/")) {
          options = { providerOptions: { gateway: { only: ["deepinfra"] } } };
        }
        if (options) {
          const model = requestedModel.startsWith("google/") ? geminiModel(requestedModel) : requestedModel;
          return { model, modelOptions: options };
        }
        return requestedModel;
      },
    },
  }),
  limits: {
    sessionUsage: () => false,
    sessionTimeoutMs: false,
  },
});
