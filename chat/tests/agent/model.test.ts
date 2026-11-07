import assert from "node:assert/strict";
import test from "node:test";
import agent from "../../agent/agent";
import { CHAT_MODEL } from "../../agent/lib/cerebras";
import { TWIN_QUERY_MODEL } from "../../agent/lib/twin-query";

function step(attributes: Record<string, string> = {}) {
  return (agent.model as any).events["step.started"]({}, { session: { auth: { current: { attributes } } }, messages: [] });
}

test("every turn runs on Qwen on Cerebras, whatever the request or env asks for", () => {
  const previous = process.env.CHAT_AGENT_MODEL;
  process.env.CHAT_AGENT_MODEL = "google/gemini-3.8-flash";
  try {
    for (const model of [undefined, "google/gemini-3.5-flash-lite", "openai/gpt-5.4", "deepseek/test-model"]) {
      const result = step(model ? { model } : {});
      assert.equal(result.model.modelId, "qwen-3.8-27b");
      assert.equal(result.model.provider, "cerebras.chat");
      assert.deepEqual(result.modelOptions.providerOptions, { cerebras: { reasoningEffort: "none" } });
    }
  } finally {
    if (previous === undefined) delete process.env.CHAT_AGENT_MODEL;
    else process.env.CHAT_AGENT_MODEL = previous;
  }
  assert.equal(CHAT_MODEL, "cerebras/qwen-3.8-27b");
  assert.equal(TWIN_QUERY_MODEL, CHAT_MODEL);
});

test("a requested reasoning effort still reaches Cerebras", () => {
  assert.deepEqual(step({ reasoningEffort: "low" }).modelOptions.providerOptions, { cerebras: { reasoningEffort: "low" } });
});
