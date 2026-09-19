import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import { trainerTwinContext } from "./instrumentation";

function fakeSpan(traceId: string, spanId: string, attributes: Record<string, unknown>) {
  const span = {
    attributes,
    spanContext: () => ({ traceId, spanId }),
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
      return span;
    },
  };
  return span as unknown as Span;
}

test("groups every active Eve span by the TrainerTwin session id", () => {
  const root = fakeSpan("trace", "root", { "eve.session.id": "wrun" });
  const child = fakeSpan("trace", "child", {
    "ai.settings.context.trainertwin.session.id": "trainer-session",
  });

  trainerTwinContext.onStart(root, {} as Context);
  trainerTwinContext.onStart(child, {} as Context);

  assert.equal(root.attributes["langfuse.session.id"], "trainer-session");
  assert.equal(child.attributes["langfuse.session.id"], "trainer-session");
  assert.equal(child.attributes["langfuse.trace.name"], "trainer-session-turn");

  trainerTwinContext.onEnd(child as unknown as ReadableSpan);
  trainerTwinContext.onEnd(root as unknown as ReadableSpan);
});
