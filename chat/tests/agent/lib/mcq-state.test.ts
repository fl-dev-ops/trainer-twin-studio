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

  test("shows the question's code: { language, content } as is, a plain string as JavaScript", () => {
    const code = { language: "javascript", content: "console.log('A');" };
    assert.deepEqual(prepareMcqPayload({ ...payload, code }).publicPayload.code, code);
    assert.deepEqual(prepareMcqPayload({ ...payload, code: "console.log('A');" }).publicPayload.code, code);
    assert.deepEqual(prepareMcqPayload({ ...payload, code: "print(1)", language: "python" }).publicPayload.code, { language: "python", content: "print(1)" });
  });

  test("refuses a question about code that carries no code, so the learner never sees options without it", () => {
    for (const question of ["Given the code shown above, what is logged, in order?", "What does this snippet print?", "What is logged?"]) {
      assert.throws(() => prepareMcqPayload({ ...payload, question }), /payload\.code/);
    }
    assert.doesNotThrow(() => prepareMcqPayload(payload));
    assert.doesNotThrow(() => prepareMcqPayload({ ...payload, question: "Given the code shown above, what is logged?", code: "console.log(1)" }));
  });

  test("rejects an answer key that is not an option", () => {
    assert.throws(() => prepareMcqPayload({ ...payload, correctOptionId: "C" }));
  });
});
