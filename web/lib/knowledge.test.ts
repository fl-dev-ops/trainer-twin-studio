import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeCollectionName } from "./knowledge";

test("knowledge storage uses immutable database IDs", () => {
  assert.equal(knowledgeCollectionName("kb-id-a"), "kb_kb-id-a");
  assert.notEqual(knowledgeCollectionName("kb-id-a"), knowledgeCollectionName("kb-id-b"));
});
