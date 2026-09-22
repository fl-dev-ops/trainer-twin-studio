import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gradeMcqSelection, prepareMcqPayload } from "../../../agent/lib/mcq-state";

describe("MCQ answer state", () => {
  const payload = {
    questionId: "q1",
    question: "Which queue drains first?",
    options: [{ id: "A", text: "Microtasks" }, { id: "B", text: "Macrotasks" }],
    correctOptionId: "A",
  };

  test("keeps the answer key out of the learner payload", () => {
    const prepared = prepareMcqPayload(payload);
    assert.deepEqual(prepared.active, { questionId: "q1", correctOptionId: "A" });
    assert.equal("correctOptionId" in prepared.publicPayload, false);
  });

  test("grades only the matching active question", () => {
    const active = { questionId: "q1", correctOptionId: "A" };
    assert.equal(gradeMcqSelection(active, "q1", "A"), true);
    assert.equal(gradeMcqSelection(active, "q1", "B"), false);
    assert.equal(gradeMcqSelection(active, "q2", "A"), null);
  });

  test("rejects an answer key that is not an option", () => {
    assert.throws(() => prepareMcqPayload({ ...payload, correctOptionId: "C" }));
  });
});
