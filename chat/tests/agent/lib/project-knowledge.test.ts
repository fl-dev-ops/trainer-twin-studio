import assert from "node:assert/strict";
import test from "node:test";
import { compactKnowledgeHit, fetchProjectKnowledge } from "../../../agent/lib/project-knowledge";
import { compileSessionPlan } from "../../../agent/lib/session-plan";
import { formatPlanTurnBlock } from "../../../agent/lib/plan-turn-block";

const hit = {
  title: "1st February",
  text: "Page: 1st February\nTopic: Code Splitting in React > Without Code Splitting (Baseline) > What happens\n\n- All components bundled together\n- Large initial download",
};

test("compacts a knowledge hit to title, topic and a short excerpt", () => {
  assert.equal(compactKnowledgeHit(hit), "1st February — Without Code Splitting (Baseline) > What happens: - All components bundled together - Large initial download");
});

test("keeps snippets only when the knowledge base reports them relevant", async () => {
  const relevant = await fetchProjectKnowledge("c1", "bundle size", async <T,>() => ({ relevant: true, results: [hit, hit] }) as T);
  assert.equal(relevant?.claimId, "c1");
  assert.equal(relevant?.snippets.length, 2);
  assert.equal(await fetchProjectKnowledge("c1", "bundle size", async <T,>() => ({ relevant: false, results: [hit] }) as T), null);
  assert.equal(await fetchProjectKnowledge("c1", "bundle size", async <T,>() => { throw new Error("down"); }), null);
});

test("plan block offers knowledge only for technical follow-ups", () => {
  const state = compileSessionPlan({
    config: { interview: { type: "resume" as const, main_questions: 2, follow_ups_per_main_question: 2 }, turns: { maximum: 12 } },
    stages: [{ id: "deep-dive", name: "Deep Dive", config: {} }],
  });
  const block = formatPlanTurnBlock(state, [], null, { claimId: "c1", snippets: ["Code splitting: ship less JavaScript"] })!;
  assert.match(block, /APPROVED KNOWLEDGE for the current project — use ONLY if your follow-up is technical/);
  assert.match(block, /- Code splitting: ship less JavaScript/);
  assert.doesNotMatch(formatPlanTurnBlock(state, [], null, null)!, /APPROVED KNOWLEDGE/);
});
