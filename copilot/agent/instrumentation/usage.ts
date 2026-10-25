import { defineInstrumentation } from "eve/instrumentation";
import { flushUsage, tokenItems, trackUsage } from "../lib/usage";

type CallState = { provider: string; model: string; orgId?: string; userId?: string };

/** One ledger delta per copilot model call, attributed to the org + trainer from ./context.ts. */
export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
  events: {
    "model.call.started": (event, ctx) => {
      const context = event.runtimeContext ?? {};
      const str = (key: string) => (typeof context[key] === "string" && context[key] ? (context[key] as string) : undefined);
      const state: CallState = {
        provider: event.model.provider,
        model: event.model.modelId,
        orgId: str("trainertwin.org.id"),
        userId: str("trainertwin.user.id"),
      };
      ctx.state.set(state);
    },
    "model.call.completed": (event, ctx) => {
      const state = ctx.state.get() as CallState | undefined;
      if (!state?.orgId) return; // local dev without the studio proxy
      trackUsage({
        kind: "delta",
        source: "copilot",
        orgId: state.orgId,
        userId: state.userId,
        idempotencyKey: `eve:${event.idempotencyKey}`,
        items: tokenItems(state.provider, event.responseModelId ?? state.model, event.usage),
        meta: { finishReason: event.finishReason, eveSessionId: event.scope.sessionId },
      });
    },
  },
  flush: flushUsage,
});
