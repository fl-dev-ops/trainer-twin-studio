import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolInput, summarizeToolOutput, withoutImageBytes } from "../../../agent/lib/tool-trace";
import readDocument from "../../../agent/tools/read_document";

test("session_plan keeps the decision fields and drops claim text", () => {
  assert.deepEqual(
    summarizeToolInput("session_plan", { action: "record_answer", answerStatus: "partial", evidenceUpdates: { ownership: "partial" } }),
    { action: "record_answer", answerStatus: "partial", evidenceUpdates: ["ownership"] },
  );
  const output = summarizeToolOutput("session_plan", {
    nextAction: { kind: "pose_main_question", questionType: "resume" },
    activeQuestion: { id: "q2", type: "resume", followUpsRemaining: 2 },
    totalTurnsUsed: 4,
    resumeClaimCandidates: [{ claimId: "c1", text: "Led the payments rewrite at Acme" }, { claimId: "c2", text: "..." }],
  });
  assert.deepEqual(output, {
    nextAction: "pose_main_question",
    nextQuestionType: "resume",
    activeQuestionId: "q2",
    followUpsRemaining: 2,
    totalTurnsUsed: 4,
    resumeClaimCandidates: ["c1", "c2"],
  });
  assert.ok(!JSON.stringify(output).includes("payments rewrite"));
  assert.ok(!JSON.stringify(summarizeToolInput("session_plan", { reply: "Private learner feedback" })).includes("Private learner feedback"));
});

test("other tools and errors never include free-text prefixes", () => {
  assert.deepEqual(
    summarizeToolInput("search_knowledge", { query: "Private learner answer", limit: 3 }),
    { query: "string", limit: "number" },
  );
  assert.deepEqual(summarizeToolOutput("search_knowledge", { error: "Private learner answer" }), { error: true });
});

test("statuses, wrapped outputs and errors", () => {
  assert.deepEqual(summarizeToolOutput("start_resume_question", { status: "highlighted" }), { status: "highlighted" });
  assert.deepEqual(
    summarizeToolOutput("start_resume_question", { status: "highlighted", nextAction: { kind: "pose_main_question" } }),
    { status: "highlighted", nextAction: "pose_main_question" },
  );
  assert.deepEqual(summarizeToolOutput("start_resume_question", { type: "json", value: { status: "not_found" } }), { status: "not_found" });
  assert.deepEqual(summarizeToolOutput("start_resume_question", null, true), { error: true });
  assert.deepEqual(
    summarizeToolInput("start_resume_question", { claimId: "c1", question: "What did you build at Private Company?" }),
    { claimId: "c1", answerStatus: null, evidenceUpdates: [] },
  );
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
