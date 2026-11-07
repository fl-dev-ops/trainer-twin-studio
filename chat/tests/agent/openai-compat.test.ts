import assert from "node:assert/strict";
import test from "node:test";
import channel from "../../agent/channels/openai-compat";

const handler = channel.routes!.find((route) => route.path === "/v1/chat/completions")!.handler as any;
const privateText = "Private learner project and interview details";

async function complete(budget?: string) {
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  let sentAttributes: Record<string, string> | undefined;
  console.info = (...args: unknown[]) => { logs.push(args); };
  try {
    // eve 0.91 (v27) facts for one turn: a bridged question call, its result, usage, then the delivery settles.
    const events = [
      { type: "turn.started", data: { turnId: "t1" } },
      { type: "model.started", data: { runId: "r1", modelId: "m", attempt: 0 } },
      { type: "call.requested", data: { callId: "q1", capability: { kind: "tool", name: "start_resume_question" }, input: { claimId: "c1", question: `${privateText}?` } } },
      { type: "call.settled", data: { callId: "q1", outcome: "completed", output: { status: "highlighted" } } },
      { type: "usage.recorded", data: { kind: "model", owner: { runId: "r1" }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
      { type: "model.settled", data: { runId: "r1", outcome: "completed" } },
      { type: "delivery.settled", data: { deliveryId: "d1", outcome: "completed" } },
    ];
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trainertwin-org-id": "org-test", "x-trainertwin-session-id": crypto.randomUUID(), ...(budget !== undefined ? { "x-thinking-budget": budget } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: privateText }] }),
    });
    const response: Response = await handler(request, {
      from: () => ({ cancel: async () => {}, send: async (_message: string, { auth }: { auth: { attributes: Record<string, string> } }) => {
        sentAttributes = auth.attributes;
        return { sessionId: "s1", deliveryId: "d1", stream: async function* () { yield* events; } };
      } }),
    });
    return { response, body: await response.text(), logs, sentAttributes };
  } finally {
    console.info = originalInfo;
  }
}

test("keeps spoken content in SSE but not logs, with one trace per output", async () => {
  const { response, body, logs } = await complete();
  assert.equal(response.status, 200);
  assert.ok(body.includes(privateText));
  assert.ok(!JSON.stringify(logs).includes(privateText));
  assert.equal(logs.filter(([message]) => String(message).startsWith("[brain-trace] ")).length, 1);
  assert.ok(!JSON.stringify(logs).includes('"brain_trace"'));
  const chunks = body.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const terminal = chunks.find((chunk) => chunk.brain_trace);
  assert.ok(terminal);
  assert.equal(terminal.brain_trace.spoken_text, undefined);
  assert.equal(terminal.timing_breakdown.brain_trace, undefined);
  assert.ok(!JSON.stringify(terminal.brain_trace).includes(privateText));
});

test("rejects invalid thinking-budget headers without sending an Eve turn", async () => {
  for (const budget of ["invalid", "", "NaN", "Infinity", "1.5", "-2", "9007199254740992"]) {
    const { response, body, sentAttributes } = await complete(budget);
    assert.equal(response.status, 400, budget);
    assert.match(JSON.parse(body).error, /thinking-budget/);
    assert.equal(sentAttributes, undefined);
  }
});

test("forwards valid thinking-budget headers unchanged", async () => {
  for (const budget of ["-1", "0", "512"]) {
    const { response, sentAttributes } = await complete(budget);
    assert.equal(response.status, 200);
    assert.equal(sentAttributes?.thinkingBudget, budget);
  }
});
