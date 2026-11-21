import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolInput, summarizeToolOutput, withoutImageBytes } from "../../../agent/lib/tool-trace";
import readDocument from "../../../agent/tools/read_document";

test("other tools and errors never include free-text prefixes", () => {
  assert.deepEqual(
    summarizeToolInput("search_knowledge", { query: "Private learner answer", limit: 3 }),
    { query: "string", limit: "number" },
  );
  assert.deepEqual(summarizeToolOutput("search_knowledge", { error: "Private learner answer" }), { error: true });
});

test("statuses, wrapped outputs and errors", () => {
  assert.deepEqual(summarizeToolOutput("end_call", { status: "ended" }), { status: "ended" });
  assert.deepEqual(summarizeToolOutput("end_call", { type: "json", value: { status: "ended" } }), { status: "ended" });
  assert.deepEqual(summarizeToolOutput("end_call", null, true), { error: true });
  assert.deepEqual(summarizeToolInput("end_call", { outcome: "completed" }), { outcome: "string" });
});

test("read_document: an image reaches the model as an image; evidence keeps a note, not the bytes", () => {
  const image = { documentId: "d1", name: "chat.png", kind: "image", image: { mediaType: "image/png", data: "aGVsbG8=" }, chunks: [] };
  const toModel = (readDocument as unknown as { toModelOutput: (output: unknown) => { type: string; value: unknown } }).toModelOutput;
  const shown = toModel(image) as { type: string; value: { type: string; data?: unknown; mediaType?: string }[] };
  assert.equal(shown.type, "content");
  assert.equal(shown.value[1].type, "file");
  assert.equal(shown.value[1].mediaType, "image/png");
  assert.match(JSON.stringify(shown.value[1]), /aGVsbG8=/);
  const pdf = { documentId: "d2", name: "cv.pdf", kind: "document", chunks: [{ index: 0, text: "Experience" }] };
  assert.deepEqual(toModel(pdf), { type: "json", value: pdf }); // documents unchanged

  const kept = withoutImageBytes(image) as { image: { mediaType: string; omitted: string; data?: string } };
  assert.equal(kept.image.data, undefined);
  assert.equal(kept.image.mediaType, "image/png");
  assert.equal(withoutImageBytes(pdf), pdf);
});
