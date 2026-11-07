import { gateway, wrapLanguageModel } from "ai";
import { defineAgent, defineDynamic } from "eve";
import { hedgedStreamMiddleware, routeTo } from "./lib/hedge";
import { SPEAKING_MODEL, SPEAKING_ROUTE } from "./lib/models";
import { thinkingBudgetSchema } from "./lib/thinking-budget";

/**
 * Backup route for stalled calls: the SAME backend (Vertex). Gemini 3 thought signatures are backend-bound, and a
 * cross-route backup broke a session ("Invalid thought signature", plan reset).
 */
const BACKUP_ROUTE = SPEAKING_ROUTE;
/** Off unless set (ms). It didn't help in heavy-thinking windows; see plans/voice-latency-optimization.md. */
const HEDGE_AFTER_MS = Number(process.env.GEMINI_HEDGE_AFTER_MS ?? 0);

function speakingModel() {
  if (!(HEDGE_AFTER_MS > 0)) return SPEAKING_MODEL;
  return wrapLanguageModel({
    model: gateway(SPEAKING_MODEL),
    middleware: hedgedStreamMiddleware({
      afterMs: HEDGE_AFTER_MS,
      backupParams: routeTo(BACKUP_ROUTE),
      onSettled: (event) => {
        if (event.hedged) console.info("[hedge] " + JSON.stringify({ model: SPEAKING_MODEL, primary: SPEAKING_ROUTE, backup: BACKUP_ROUTE, afterMs: HEDGE_AFTER_MS, ...event }));
      },
    }),
  });
}

export default defineAgent({
  defaultTools: false,
  // Every reply: the speaking model (lib/models.ts), whatever CHAT_AGENT_MODEL or a request header asks for.
  // eve runs this before every model call.
  model: defineDynamic(async (ctx) => {
    const attributes = (ctx.session.auth.current?.attributes ?? {}) as Record<string, string | undefined>;
    const rawBudget = attributes.thinkingBudget ?? process.env.GEMINI_THINKING_BUDGET;
    const baseBudget = rawBudget !== undefined ? thinkingBudgetSchema.parse(rawBudget) : undefined;
    const isAsymmetric = attributes.asymmetricThinking === "1" || process.env.ASYMMETRIC_THINKING === "1";
    // Only the asymmetric experiment needs the history (to spot a tool follow-up); skip assembling it otherwise.
    const messages = baseBudget !== undefined && isAsymmetric ? await ctx.messages() : [];
    const isToolFollowup = messages.length > 0 && messages[messages.length - 1]?.role === "tool";
    const budget = baseBudget !== undefined && isToolFollowup && isAsymmetric ? 0 : baseBudget;
    // Gemini 3.x ignores thinkingBudget in practice (budget 0 still thought on 21/30 calls) but
    // honours thinkingLevel; "low" halved average thinking and cut calls over 5 s from 9/30 to 4/30.
    // An explicit budget (header/env) still wins so budget experiments keep working.
    const thinkingLevel = attributes.thinkingLevel || process.env.GEMINI_THINKING_LEVEL || "low";
    const thinkingConfig: Record<string, string | number> = budget !== undefined ? { thinkingBudget: budget } : { thinkingLevel };
    return {
      model: speakingModel(),
      modelOptions: {
        providerOptions: {
          gateway: { only: [SPEAKING_ROUTE] },
          google: { thinkingConfig },
        },
      },
    };
  }),
  limits: {
    sessionUsage: () => false,
    sessionTimeoutMs: false,
  },
});
