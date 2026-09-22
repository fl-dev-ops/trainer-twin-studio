import assert from "node:assert/strict";
import test from "node:test";
import { normalizeKnowledgeLookup, shouldRetrieveKnowledge } from "../../../lib/runtime/openai";

test("knowledge retrieval runs only for a valid requested lookup with an approved KB", () => {
  const lookup = normalizeKnowledgeLookup({ needed: true, query: "  React useCallback tradeoffs  " });
  assert.deepEqual(lookup, { needed: true, query: "React useCallback tradeoffs" });
  assert.equal(shouldRetrieveKnowledge(lookup, ["approved-kb"], true), true);
  assert.equal(shouldRetrieveKnowledge(lookup, [], true), false);
  assert.equal(shouldRetrieveKnowledge(lookup, ["approved-kb"], false), false);
});

test("knowledge retrieval defaults off for unneeded or malformed classifier output", () => {
  for (const value of [
    undefined,
    null,
    {},
    { needed: false, query: "React hooks" },
    { needed: true, query: " " },
    { needed: "true", query: "React hooks" },
  ]) {
    const lookup = normalizeKnowledgeLookup(value);
    assert.deepEqual(lookup, { needed: false, query: "" });
    assert.equal(shouldRetrieveKnowledge(lookup, ["approved-kb"], true), false);
  }
});
