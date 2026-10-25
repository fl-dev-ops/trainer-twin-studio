import { defineInstrumentation } from "eve/instrumentation";
import { flushUsage, tokenItems, trackUsage } from "../lib/usage";

type CallState = { provider: string; model: string; sessionId?: string; orgId?: string };

/**
 * One ledger delta per model call. Our InterviewSession id is not on lifecycle events (eve's own
 * session id differs), so it comes from runtimeContext set in ./langfuse.ts and is carried from
 * model.call.started to model.call.completed via ctx.state.
 */
export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
  events: {
    "model.call.started": (event, ctx) => {
      const context = event.runtimeContext ?? {};
      const str = (key: string) => (typeof context[key] === "string" && context[key] ? (context[key] as string) : undefined);
      const state: CallState = {
        provider: event.model.provider,
        model: event.model.modelId,
        sessionId: str("trainertwin.session.id"),
        orgId: str("trainertwin.org.id"),
      };
      ctx.state.set(state);
    },
    "model.call.completed": (event, ctx) => {
      const state = ctx.state.get() as CallState | undefined;
      if (!state?.sessionId) return; // not a TrainerTwin session (e.g. local dev without headers)
      trackUsage({
        kind: "delta",
        source: "chat",
        sessionId: state.sessionId,
        orgId: state.orgId,
        idempotencyKey: `eve:${event.idempotencyKey}`,
        items: tokenItems(state.provider, event.responseModelId ?? state.model, event.usage),
        meta: { finishReason: event.finishReason, turnId: event.scope.turnId, stepIndex: event.scope.stepIndex },
      });
    },
  },
  flush: flushUsage,
});
