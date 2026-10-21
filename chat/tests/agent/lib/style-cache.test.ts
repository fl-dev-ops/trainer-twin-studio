import assert from "node:assert/strict";
import test from "node:test";
import { compactStyleExample, fetchStyleCache, STYLE_SITUATIONS } from "../../../agent/lib/style-cache";
import { compileSessionPlan } from "../../../agent/lib/session-plan";
import { formatPlanTurnBlock } from "../../../agent/lib/plan-turn-block";

const sample = [
  "PAST STYLE EXAMPLE — wording only, not facts about the current learner.",
  "Session phase: middle",
  "Learner state: closing",
  "Speech function: acknowledge -> feedback -> probe",
  "Cadence: detailed, evaluative, encouraging",
  `Topic-neutral pattern: Yes. Good, good, <learner>. ${"x".repeat(400)}`,
].join("\n");

test("compacts a style hit to function, cadence and a short pattern", () => {
  const compact = compactStyleExample(sample);
  assert.match(compact, /^does: acknowledge -> feedback -> probe; cadence: detailed, evaluative, encouraging; sounds like: "Yes\. Good, good, <learner>\./);
  assert.ok(compact.length < 420);
  assert.doesNotMatch(compact, /PAST STYLE EXAMPLE|Session phase/);
});

test("fetches one lookup per situation and keeps two examples each", async () => {
  const queries: string[] = [];
  const cache = await fetchStyleCache("Vasanth", async <T,>(payload: Record<string, unknown>) => {
    queries.push(String(payload.query));
    return { phrasingStyle: [{ text: sample }, { text: sample }, { text: sample }] } as T;
  });
  assert.deepEqual(queries.sort(), Object.values(STYLE_SITUATIONS).sort());
  assert.equal(cache.follow_up?.length, 2);
});

test("plan block shows the style for the moments this turn can lead to", () => {
  const state = compileSessionPlan({
    config: { interview: { type: "resume" as const, main_questions: 2, follow_ups_per_main_question: 2 }, turns: { maximum: 12 } },
    stages: [{ id: "deep-dive", name: "Deep Dive", config: {} }],
  });
  const style = { follow_up: ["does: probe"], dont_know: ["does: reassure"], next_question: ["does: transition"] };
  const block = formatPlanTurnBlock(state, [], style)!;
  assert.match(block, /TRAINER STYLE/);
  assert.match(block, /- \[follow up\] does: probe/);
  assert.match(block, /- \[dont know\] does: reassure/);
  assert.match(block, /- \[next question\] does: transition/);
  assert.doesNotMatch(formatPlanTurnBlock(state, [], null)!, /TRAINER STYLE/);
});
