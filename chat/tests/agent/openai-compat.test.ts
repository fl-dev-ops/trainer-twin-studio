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
    const events = [
      { type: "turn.started", data: {} },
      { type: "step.started", data: {} },
      { type: "actions.requested", data: { actions: [{ kind: "tool-call", callId: "q1", toolName: "start_resume_question", input: { claimId: "c1", question: `${privateText}?` } }] } },
      { type: "action.result", data: { result: { kind: "tool-result", callId: "q1", toolName: "start_resume_question", output: { status: "highlighted" } } } },
      { type: "step.completed", data: { usage: { inputTokens: 10, outputTokens: 5 } } },
      { type: "session.waiting", data: {} },
    ];
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trainertwin-org-id": "org-test", "x-trainertwin-session-id": crypto.randomUUID(), ...(budget !== undefined ? { "x-thinking-budget": budget } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: privateText }] }),
    });
    const response: Response = await handler(request, {
      resolveSession: async () => undefined,
      from: () => ({ send: async (_message: string, { auth }: { auth: { attributes: Record<string, string> } }) => {
        sentAttributes = auth.attributes;
        return { cancel: async () => {}, getEventStream: async () => new ReadableStream({ start(controller) {
          for (const event of events) controller.enqueue(event);
          controller.close();
        } }) };
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
