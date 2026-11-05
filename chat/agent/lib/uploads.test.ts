import assert from "node:assert/strict";
import { test } from "node:test";
import { withAttachments } from "./uploads";

test("a message without a marker stays plain text", () => {
  assert.equal(withAttachments("hello"), "hello");
});

test("each [ATTACHED id] becomes a file part pointing at the upload", () => {
  const parts = withAttachments("I've attached a file: deck.pdf [ATTACHED abc-123]") as Array<{ type: string; text?: string; data?: URL }>;
  assert.ok(Array.isArray(parts));
  assert.match(parts[0].text ?? "", /deck\.pdf \(document ID abc-123\)/);
  assert.equal(parts[1].type, "file");
  assert.equal(String(parts[1].data), "trainertwin-upload://abc-123");
});

test("duplicates collapse and at most four files go through", () => {
  const content = withAttachments(`[ATTACHED a] ${["a", "b", "c", "d", "e"].map((id) => `[ATTACHED ${id}]`).join(" ")}`) as Array<{ type: string }>;
  assert.equal(content.filter((part) => part.type === "file").length, 4);
});
