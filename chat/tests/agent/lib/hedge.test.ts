import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { hedgedStreamMiddleware, routeTo, type HedgeEvent } from "../../../agent/lib/hedge";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake model: call i streams stream-start, waits delays[i] ms, then one text part + finish. Records each call's route. */
function fakeModel(delays: number[], { failFirst = false } = {}) {
  const aborted: boolean[] = [];
  const routes: unknown[] = [];
  let calls = 0;
  const model = {
    doStream: async (options: LanguageModelV4CallOptions) => {
      const index = calls++;
      aborted[index] = false;
      routes[index] = (options.providerOptions as any)?.gateway?.only?.[0];
      options.abortSignal?.addEventListener("abort", () => { aborted[index] = true; });
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] } as LanguageModelV4StreamPart);
          await sleep(delays[index]);
          if (failFirst && index === 0) return controller.error(new Error("gateway failed"));
          if (aborted[index]) return;
          controller.enqueue({ type: "text-delta", id: "t", delta: `answer-${index}` } as LanguageModelV4StreamPart);
          controller.enqueue({ type: "finish" } as LanguageModelV4StreamPart);
          controller.close();
        },
      });
      return { stream };
    },
  } as unknown as LanguageModelV4;
  return { model, aborted, routes, calls: () => calls };
}

const vertexParams = { providerOptions: { gateway: { only: ["vertex"] }, google: { thinkingConfig: { thinkingLevel: "low" } } } } as unknown as LanguageModelV4CallOptions;

async function run(model: LanguageModelV4, afterMs: number) {
  const events: HedgeEvent[] = [];
  const middleware = hedgedStreamMiddleware({ afterMs, backupParams: routeTo("google"), onSettled: (event) => events.push(event) });
  const { stream } = await middleware.wrapStream!({ params: vertexParams, model, doGenerate: undefined as never, doStream: undefined as never });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream as unknown as AsyncIterable<LanguageModelV4StreamPart>) parts.push(part);
  const text = parts.filter((part) => part.type === "text-delta").map((part) => (part as { delta: string }).delta).join("");
  return { text, events, types: parts.map((part) => part.type) };
}

test("routeTo swaps only the gateway route and keeps other provider options", () => {
  const backup = routeTo("google")(vertexParams) as any;
  assert.deepEqual(backup.providerOptions.gateway.only, ["google"]);
  assert.deepEqual(backup.providerOptions.google, { thinkingConfig: { thinkingLevel: "low" } });
  assert.deepEqual((vertexParams as any).providerOptions.gateway.only, ["vertex"]);
});

test("a fast primary call is not hedged and streams through unchanged", async () => {
  const fake = fakeModel([20]);
  const result = await run(fake.model, 200);
  assert.equal(result.text, "answer-0");
  assert.deepEqual(result.types, ["stream-start", "text-delta", "finish"]);
  assert.deepEqual(fake.routes, ["vertex"]);
  assert.equal(result.events[0].hedged, false);
});

test("a stalled primary is hedged to the backup route, which wins; the primary is aborted", async () => {
  const fake = fakeModel([1000, 20]);
  const result = await run(fake.model, 50);
  assert.equal(result.text, "answer-1");
  assert.deepEqual(fake.routes, ["vertex", "google"]);
  assert.equal(result.events[0].winner, "backup");
  assert.ok(result.events[0].firstOutputMs < 500);
  assert.equal(fake.aborted[0], true);
});

test("if the primary still wins after the backup started, the backup is aborted", async () => {
  const fake = fakeModel([80, 1000]);
  const result = await run(fake.model, 50);
  assert.equal(result.text, "answer-0");
  assert.equal(result.events[0].winner, "primary");
  assert.equal(fake.aborted[1], true);
});

test("an error surfaces only when no other attempt can still win", async () => {
  await assert.rejects(run(fakeModel([10], { failFirst: true }).model, 500), /gateway failed/);
  const rescued = await run(fakeModel([60, 30], { failFirst: true }).model, 20);
  assert.equal(rescued.text, "answer-1");
});
