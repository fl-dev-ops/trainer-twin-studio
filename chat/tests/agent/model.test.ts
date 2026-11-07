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

function step(attributes: Record<string, string> = {}, messages: unknown[] = []) {
  return (agent.model as any).events["step.started"]({}, { session: { auth: { current: { attributes } } }, messages });
}
const thinking = (attributes: Record<string, string> = {}, messages: unknown[] = []) =>
  step(attributes, messages).modelOptions.providerOptions.google.thinkingConfig;

test("every reply runs on Gemini on Vertex; the decision model is Qwen on Cerebras", () => {
  process.env.CHAT_AGENT_MODEL = "cerebras/qwen-3.8-27b";
  for (const model of [undefined, "cerebras/qwen-3.8-27b", "openai/gpt-5.4", "google/gemini-3.5-flash-lite"]) {
    const result = step(model ? { model } : {});
    assert.equal(result.model, "google/gemini-3.8-flash");
    assert.deepEqual(result.modelOptions.providerOptions.gateway, { only: ["vertex"] });
  }
  assert.equal(SPEAKING_MODEL, "google/gemini-3.8-flash");
  assert.equal(SPEAKING_ROUTE, "vertex");
  assert.equal(TWIN_QUERY_MODEL, DECISION_MODEL);
  assert.equal(DECISION_MODEL, "cerebras/qwen-3.8-27b");
});

test("keeps low thinking by default and accepts supported integer overrides", () => {
  assert.deepEqual(thinking(), { thinkingLevel: "low" });
  for (const budget of ["-1", "0", "512", " 256 "]) {
    assert.deepEqual(thinking({ thinkingBudget: budget }), { thinkingBudget: Number(budget) });
  }
  process.env.GEMINI_THINKING_BUDGET = "1024";
  assert.deepEqual(thinking(), { thinkingBudget: 1024 });
  assert.deepEqual(thinking({ thinkingBudget: "0" }), { thinkingBudget: 0 });
});

test("rejects malformed header attributes and environment budgets before model calls", () => {
  for (const budget of ["", "not-a-number", "NaN", "Infinity", "1.5", "-2", "9007199254740992", " "]) {
    assert.throws(() => thinking({ thinkingBudget: budget }));
  }
  process.env.GEMINI_THINKING_BUDGET = "not-a-number";
  assert.throws(() => thinking());
});

test("preserves explicit asymmetric thinking on tool follow-ups", () => {
  const attributes = { thinkingBudget: "256", asymmetricThinking: "1" };
  assert.deepEqual(thinking(attributes), { thinkingBudget: 256 });
  assert.deepEqual(thinking(attributes, [{ role: "tool" }]), { thinkingBudget: 0 });
  assert.deepEqual(thinking({ asymmetricThinking: "1" }, [{ role: "tool" }]), { thinkingLevel: "low" });
  assert.throws(() => thinking({ thinkingBudget: "invalid", asymmetricThinking: "1" }, [{ role: "tool" }]));
});
