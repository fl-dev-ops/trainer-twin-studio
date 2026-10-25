import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import usageInstrumentation from "../../agent/instrumentation/usage";
import { flushUsage, postUsage, tokenItems } from "../../agent/lib/usage";

type Posted = { url: string; auth: string | null; body: Record<string, unknown> };
let posted: Posted[] = [];
let statuses: number[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  posted = [];
  statuses = [];
  process.env.COPILOT_SERVICE_SECRET = "sek";
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    posted.push({
      url: String(url),
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    });
    return new Response("{}", { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stateSlot() {
  let value: unknown;
  return { state: { get: () => value, set: (v: unknown) => { value = v; } } };
}

const handlers = usageInstrumentation.events as Record<string, (event: unknown, ctx: unknown) => void>;

test("tokenItems keeps only positive usage and maps eve fields", () => {
  assert.deepEqual(
    tokenItems("gateway", "google/gemini-3.5-flash-lite", {
      inputTokens: 3120, outputTokens: 214, costUsd: 0.0004,
      inputTokenDetails: { cacheReadTokens: 2048, cacheWriteTokens: 0 },
    }).map((i) => [i.metric, i.value]),
    [["input_tokens", 3120], ["output_tokens", 214], ["cache_read_tokens", 2048], ["cost_usd", 0.0004]],
  );
});

test("model call → one delta keyed by eve idempotencyKey, attributed by runtimeContext session", async () => {
  const ctx = stateSlot();
  handlers["model.call.started"]({
    idempotencyKey: "call-1",
    model: { provider: "gateway", modelId: "google/gemini-3.5-flash-lite" },
    runtimeContext: { "trainertwin.session.id": "sess-1", "trainertwin.org.id": "org-1" },
    scope: {},
  }, ctx);
  handlers["model.call.completed"]({
    idempotencyKey: "call-1",
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20 },
    scope: { turnId: "t1", stepIndex: 0 },
  }, ctx); // returns immediately; post happens in the background
  await flushUsage();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].auth, "Bearer sek");
  assert.match(posted[0].url, /\/api\/internal\/usage$/);
  assert.deepEqual(posted[0].body, {
    kind: "delta", source: "chat", sessionId: "sess-1", orgId: "org-1", idempotencyKey: "eve:call-1",
    items: [
      { provider: "gateway", model: "google/gemini-3.5-flash-lite", metric: "input_tokens", value: 100 },
      { provider: "gateway", model: "google/gemini-3.5-flash-lite", metric: "output_tokens", value: 20 },
    ],
    meta: { finishReason: "stop", turnId: "t1", stepIndex: 0 },
  });
});

test("calls without a TrainerTwin session are not reported", async () => {
  const ctx = stateSlot();
  handlers["model.call.started"]({ idempotencyKey: "x", model: { provider: "gateway", modelId: "m" }, scope: {} }, ctx);
  handlers["model.call.completed"]({ idempotencyKey: "x", finishReason: "stop", usage: { inputTokens: 5 }, scope: {} }, ctx);
  await flushUsage();
  assert.equal(posted.length, 0);
});

test("retries once on 5xx, never on 4xx", async () => {
  const payload = { kind: "delta" as const, source: "chat" as const, sessionId: "s", idempotencyKey: "k",
    items: [{ provider: "p", model: "m", metric: "input_tokens" as const, value: 1 }] };
  statuses = [503, 200];
  await postUsage(payload);
  assert.equal(posted.length, 2);

  posted = [];
  statuses = [404];
  await postUsage(payload);
  assert.equal(posted.length, 1);
});
