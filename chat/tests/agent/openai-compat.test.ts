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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.action, "authorizeRuntimeSession");
    return Response.json({ valid: true, anonymous: false });
  };
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
    globalThis.fetch = originalFetch;
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

test("public completions require server validation on every turn and carry trusted runtime attributes", async () => {
  const originalFetch = globalThis.fetch;
  let valid = true;
  const admissions: Record<string, string>[] = [];
  const validations: unknown[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    validations.push(JSON.parse(String(init?.body)));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-trainertwin-session-id"), "public-session");
    assert.equal(headers.get("x-trainertwin-runtime-token"), "runtime-secret");
    return Response.json({ valid, anonymous: true });
  };
  const request = (mode = "voice", token = "runtime-secret") => new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from("org-test:test-secret").toString("base64")}`,
      "x-trainertwin-session-id": "public-session",
      "x-trainertwin-runtime-token": token,
      "x-trainertwin-mode": mode,
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "How should I handle this buyer?" }] }),
  });
  const transport = {
    from: () => ({
      send: async (_text: string, { auth }: { auth: { attributes: Record<string, string> } }) => {
        admissions.push(auth.attributes);
        return { deliveryId: "public-delivery", stream: async function* () {
          yield { type: "delivery.settled", data: { outcome: "completed" } };
        } };
      },
    }),
  };
  try {
    const first = await handler(request(), transport);
    assert.equal(first.status, 200);
    await first.text();
    assert.equal(admissions[0]?.anonymous, "1");
    assert.equal(admissions[0]?.runtimeToken, "runtime-secret");
    valid = false;
    assert.equal((await handler(request(), transport)).status, 403);
    valid = true;
    assert.equal((await handler(request("chat"), transport)).status, 403);
    assert.equal((await handler(request("voice", ""), transport)).status, 403);
    assert.equal(admissions.length, 1);
    assert.equal(validations.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [name, outcome, result, spoken, expected] of [
  ["client agrees", "agreed", "ended", "", "Okay, speak then. Bye for now."],
  ["client declines", "declined", "ended", "", "Sorry, I have to go. Bye."],
  ["client runs out of patience", "guard_ran_out", "ended", "", "Sorry, I have to go. Bye."],
  ["authored practice completes", "completed", "ended", "", "Thank you, that's all for today."],
  ["the model gives its own goodbye", "completed", "ended", "Thanks for walking me through it.", "Thanks for walking me through it."],
  ["the tool is disabled", "completed", "disabled", "", ""],
  ["closing the session fails", "completed", "failed", "", ""],
] as const) {
  test(`end_call SSE: ${name}`, async () => {
    const { response, body } = await complete(undefined, [
      { type: "turn.started", data: { turnId: "t1" } },
      ...(spoken ? [{ type: "content.delta", data: { partId: "p1", kind: "text", delta: spoken } }] : []),
      { type: "call.requested", data: { callId: "hangup", capability: { kind: "tool", name: "end_call" }, input: { outcome } } },
      { type: "call.settled", data: {
        callId: "hangup", outcome: result === "failed" ? "failed" : "completed",
        output: result === "disabled" ? { disabled: true } : { status: result, outcome },
      } },
      ...(result === "ended" ? [
        { type: "model.started", data: { runId: "after-hangup" } },
        { type: "content.delta", data: { partId: "p2", kind: "text", delta: "(The call has ended.)" } },
      ] : []),
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

test("a goodbye without end_call still hangs the call up", async () => {
  const actions: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { action?: string };
    actions.push(payload.action ?? "");
    if (payload.action === "authorizeRuntimeSession") return Response.json({ valid: true, anonymous: false });
    return Response.json({ status: "queued" });
  };
  try {
    const response: Response = await handler(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from("org-test:test-secret").toString("base64")}`,
        "x-trainertwin-session-id": "call-1",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "Thursday works." }] }),
    }), {
      waitUntil: (work: Promise<unknown>) => work,
      from: () => ({
        cancel: async () => {},
        send: async () => ({
          sessionId: "s1",
          deliveryId: "d1",
          stream: async function* () {
            yield { type: "turn.started", data: { turnId: "t1" } };
            yield { type: "content.delta", data: { partId: "p1", kind: "text", delta: "Thursday at seven works. Talk then, bye." } };
            yield { type: "delivery.settled", data: { deliveryId: "d1", outcome: "completed" } };
          },
        }),
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes("Talk then, bye."), true);
    assert.equal(body.includes("(The call has ended.)"), false);
    assert.equal(actions.includes("finishSession"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
