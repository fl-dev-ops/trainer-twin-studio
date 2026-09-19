import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

const activeSpans = new Map<string, Set<Span>>();
const trainerTwinSessions = new Map<string, string>();

function stringAttribute(span: Span, key: string) {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

export const trainerTwinContext: SpanProcessor = {
  onStart(span) {
    const traceId = span.spanContext().traceId;
    const spans = activeSpans.get(traceId) ?? new Set<Span>();
    spans.add(span);
    activeSpans.set(traceId, spans);

    const trainerTwinSession = stringAttribute(span, "ai.settings.context.trainertwin.session.id");
    if (trainerTwinSession) {
      trainerTwinSessions.set(traceId, trainerTwinSession);
      for (const activeSpan of spans) activeSpan.setAttribute("langfuse.session.id", trainerTwinSession);
    } else {
      const sessionId =
        trainerTwinSessions.get(traceId) ??
        stringAttribute(span, "eve.session.id") ??
        stringAttribute(span, "agent.session.id") ??
        stringAttribute(span, "ai.settings.context.eve.session.id");
      if (sessionId) span.setAttribute("langfuse.session.id", sessionId);
    }

    span.setAttribute("langfuse.trace.name", "trainer-session-turn");
    span.setAttribute("langfuse.trace.tags", ["trainer-session"]);
  },
  onEnd(span: ReadableSpan) {
    const traceId = span.spanContext().traceId;
    const spans = activeSpans.get(traceId);
    if (!spans) return;
    for (const activeSpan of spans) {
      if (activeSpan.spanContext().spanId === span.spanContext().spanId) spans.delete(activeSpan);
    }
    if (!spans.size) {
      activeSpans.delete(traceId);
      trainerTwinSessions.delete(traceId);
    }
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};

export default defineInstrumentation({
  events: {
    "step.started": ({ session }) => {
      const sessionId = session.auth.current?.attributes.sessionId;
      return typeof sessionId === "string"
        ? { runtimeContext: { "trainertwin.session.id": sessionId } }
        : undefined;
    },
  },
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      spanProcessors: [
        trainerTwinContext,
        new LangfuseSpanProcessor({
          environment: process.env.VERCEL_ENV ?? "development",
          exportMode: process.env.VERCEL ? "immediate" : "batched",
          release: process.env.VERCEL_GIT_COMMIT_SHA,
          shouldExportSpan: ({ otelSpan }) =>
            isDefaultExportSpan(otelSpan) || ["gen_ai", "eve"].includes(otelSpan.instrumentationScope.name),
        }),
      ],
    }),
});
