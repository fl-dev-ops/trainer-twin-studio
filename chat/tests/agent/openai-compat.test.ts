import assert from "node:assert/strict";
import test from "node:test";
import channel from "../../agent/channels/openai-compat";

const handler = channel.routes!.find((route) => route.path === "/v1/chat/completions")!.handler as any;
process.env.COPILOT_SERVICE_SECRET = "test-secret";

test("refuses a completion without the service secret, even with an org header", async () => {
  const cases: Record<string, string>[] = [
    { "x-trainertwin-org-id": "org-test" },
    { "x-trainertwin-org-id": "org-test", authorization: "Bearer some-token" },
    { authorization: `Basic ${Buffer.from("org-test:wrong").toString("base64")}` },
  ];
  for (const headers of cases) {
    const response: Response = await handler(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }), { from: () => { throw new Error("the model must not run"); } });
    assert.equal(response.status, 401);
  }
});
const privateText = "Private learner project and interview details";

type Fact = { type: string; data: Record<string, unknown> };

async function complete(budget?: string, facts?: Fact[]) {
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  let sentAttributes: Record<string, string> | undefined;
  console.info = console.warn = (...args: unknown[]) => { logs.push(args); };
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
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("org-test:test-secret").toString("base64")}`, ...(!facts ? { "x-trainertwin-session-id": crypto.randomUUID() } : {}), ...(budget !== undefined ? { "x-thinking-budget": budget } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: privateText }] }),
    });
    const response: Response = await handler(request, {
      from: () => ({ cancel: async () => {}, send: async (_message: string, { auth }: { auth: { attributes: Record<string, string> } }) => {
        sentAttributes = auth.attributes;
        return { sessionId: "s1", deliveryId: "d1", stream: async function* () { yield* facts ?? events; } };
      } }),
    });
    return { response, body: await response.text(), logs, sentAttributes };
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
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

for (const [name, outcome, result, spoken, expected] of [
  ["client agrees", "agreed", "ended", "", "Okay, speak then. Bye for now."],
  ["client declines", "declined", "ended", "", "Sorry, I have to go. Bye."],
  ["client runs out of patience", "guard_ran_out", "ended", "", "Sorry, I have to go. Bye."],
  ["authored practice completes", "completed", "ended", "", "Okay, thank you."],
  ["the model gives its own goodbye", "completed", "ended", "Thanks for walking me through it.", "Thanks for walking me through it."],
  ["the tool is disabled", "completed", "disabled", "", ""],
  ["closing the session fails", "completed", "failed", "", ""],
] as const) {
  test(`end_call SSE: ${name}`, async () => {
    const { response, body } = await complete(undefined, [
      { type: "turn.started", data: { turnId: "t1" } },
      { type: "call.requested", data: { callId: "hangup", capability: { kind: "tool", name: "end_call" }, input: { outcome } } },
      { type: "call.settled", data: {
        callId: "hangup", outcome: result === "failed" ? "failed" : "completed",
        output: result === "disabled" ? { disabled: true } : { status: result, outcome },
      } },
      { type: "content.delta", data: { partId: "p1", kind: "text", delta: spoken || "  " } },
      { type: "delivery.settled", data: { deliveryId: "d1", outcome: "completed" } },
    ]);
    assert.equal(response.status, 200);
    const frames = body.trim().split("\n\n");
    assert.equal(frames.pop(), "data: [DONE]");
    const choices = frames.map((frame) => JSON.parse(frame.slice(6)).choices[0]);
    assert.equal(choices.map((choice) => choice.delta.content ?? "").join(""), expected);
    assert.equal(choices.at(-1)?.finish_reason, "stop");
  });
}

for (const [name, facts] of [
  ["provider fails before any reply", [
    { type: "turn.settled", data: { turnId: "t1", outcome: "failed", error: { message: "private provider error" } } },
    { type: "delivery.settled", data: { deliveryId: "d1", outcome: "handled" } },
  ]],
  ["stream breaks after partial text", [
    { type: "content.delta", data: { partId: "p1", kind: "text", delta: "One moment" } },
  ]],
  ["turn produces only reasoning", [
    { type: "content.delta", data: { partId: "p1", kind: "reasoning", delta: "private reasoning" } },
    { type: "delivery.settled", data: { deliveryId: "d1", outcome: "handled" } },
  ]],
] satisfies [string, Fact[]][]) {
  test(`a text client can retry when the ${name}`, async () => {
    const { response, body } = await complete(undefined, [{ type: "turn.started", data: { turnId: "t1" } }, ...facts]);
    assert.equal(response.status, 200);
    assert.match(body, /"code":"chat_turn_failed"/);
    assert.doesNotMatch(body, /"finish_reason":"stop"|private provider error|private reasoning/);
    assert.ok(body.trimEnd().endsWith("data: [DONE]"));
  });
}

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
