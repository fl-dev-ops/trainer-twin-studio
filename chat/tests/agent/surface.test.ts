import assert from "node:assert/strict";
import test from "node:test";
import { inputSchema } from "../../agent/tools/surface";

test("planned question surfaces require a question ID", () => {
  assert.throws(() => inputSchema.parse({ action: "open_code_editor", payload: {} }), /questionId/);
  assert.doesNotThrow(() => inputSchema.parse({
    action: "open_code_editor",
    payload: { questionId: "coding:1" },
  }));
  assert.doesNotThrow(() => inputSchema.parse({ action: "close_surface" }));
});
