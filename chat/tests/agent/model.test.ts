import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import agent from "../../agent/agent";

const envNames = ["GEMINI_THINKING_BUDGET", "GEMINI_THINKING_LEVEL", "ASYMMETRIC_THINKING"];
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

function options(attributes: Record<string, string> = {}, messages: unknown[] = []) {
  return (agent.model as any).events["step.started"]({}, {
    session: { auth: { current: { attributes: { model: "google/gemini-3.5-flash-lite", ...attributes } } } },
    messages,
  }).modelOptions;
}

const thinking = (attributes: Record<string, string> = {}, messages: unknown[] = []) =>
  options(attributes, messages).providerOptions.google.thinkingConfig;

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
  assert.deepEqual(options({ model: "deepseek/test-model" }).providerOptions, { gateway: { only: ["deepinfra"] } });
});

test("preserves explicit asymmetric thinking on tool follow-ups", () => {
  const attributes = { thinkingBudget: "256", asymmetricThinking: "1" };
  assert.deepEqual(thinking(attributes), { thinkingBudget: 256 });
  assert.deepEqual(thinking(attributes, [{ role: "tool" }]), { thinkingBudget: 0 });
  assert.deepEqual(thinking({ asymmetricThinking: "1" }, [{ role: "tool" }]), { thinkingLevel: "low" });
  assert.throws(() => thinking({ thinkingBudget: "invalid", asymmetricThinking: "1" }, [{ role: "tool" }]));
});
