import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import agent from "../../agent/agent";
import { DECISION_MODEL, SPEAKING_MODEL, SPEAKING_ROUTE } from "../../agent/lib/models";
import { TWIN_QUERY_MODEL } from "../../agent/lib/twin-query";

const envNames = ["GEMINI_THINKING_BUDGET", "GEMINI_THINKING_LEVEL", "ASYMMETRIC_THINKING", "CHAT_AGENT_MODEL"];
let previousEnv: Record<string, string | undefined>;
beforeEach(() => {
  previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
});
afterEach(() => {
  for (const name of envNames) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
});

/** Runs the agent's dynamic model function (eve 0.91: `defineDynamic(ctx => …)`) on a fake session frame. */
function step(attributes: Record<string, string> = {}, messages: unknown[] = []) {
  const resolve = (agent.model as any)[Symbol.for("eve.dynamic")];
  return resolve({ session: { auth: { current: { attributes } } }, messages: async () => messages });
}
const thinking = async (attributes: Record<string, string> = {}, messages: unknown[] = []) =>
  (await step(attributes, messages)).modelOptions.providerOptions.google.thinkingConfig;

test("every reply runs on Gemini on Vertex; the decision model is Qwen on Cerebras", async () => {
  process.env.CHAT_AGENT_MODEL = "cerebras/qwen-3.8-27b";
  for (const model of [undefined, "cerebras/qwen-3.8-27b", "openai/gpt-5.4", "google/gemini-3.5-flash-lite"]) {
    const result = await step(model ? { model } : {});
    assert.equal(result.model, "google/gemini-3.8-flash");
    assert.deepEqual(result.modelOptions.providerOptions.gateway, { only: ["vertex"] });
    assert.deepEqual(result.modelOptions.providerOptions.vertex, { sharedRequestType: "priority" });
  }
  assert.equal(SPEAKING_MODEL, "google/gemini-3.8-flash");
  assert.equal(SPEAKING_ROUTE, "vertex");
  assert.equal(TWIN_QUERY_MODEL, DECISION_MODEL);
  assert.equal(DECISION_MODEL, "cerebras/qwen-3.8-27b");
});

test("keeps low thinking by default and accepts supported integer overrides", async () => {
  assert.deepEqual(await thinking(), { thinkingLevel: "low" });
  for (const budget of ["-1", "0", "512", " 256 "]) {
    assert.deepEqual(await thinking({ thinkingBudget: budget }), { thinkingBudget: Number(budget) });
  }
  process.env.GEMINI_THINKING_BUDGET = "1024";
  assert.deepEqual(await thinking(), { thinkingBudget: 1024 });
  assert.deepEqual(await thinking({ thinkingBudget: "0" }), { thinkingBudget: 0 });
});

test("rejects malformed header attributes and environment budgets before model calls", async () => {
  for (const budget of ["", "not-a-number", "NaN", "Infinity", "1.5", "-2", "9007199254740992", " "]) {
    await assert.rejects(() => thinking({ thinkingBudget: budget }));
  }
  process.env.GEMINI_THINKING_BUDGET = "not-a-number";
  await assert.rejects(() => thinking());
});

test("preserves explicit asymmetric thinking on tool follow-ups", async () => {
  const attributes = { thinkingBudget: "256", asymmetricThinking: "1" };
  assert.deepEqual(await thinking(attributes), { thinkingBudget: 256 });
  assert.deepEqual(await thinking(attributes, [{ role: "tool" }]), { thinkingBudget: 0 });
  assert.deepEqual(await thinking({ asymmetricThinking: "1" }, [{ role: "tool" }]), { thinkingLevel: "low" });
  await assert.rejects(() => thinking({ thinkingBudget: "invalid", asymmetricThinking: "1" }, [{ role: "tool" }]));
});
