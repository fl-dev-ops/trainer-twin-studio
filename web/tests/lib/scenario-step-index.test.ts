import { expect, test } from "bun:test";
import { scenarioStepIndex } from "@/lib/main-collection";

test("maps steps to their moves and moves back to their first step (both sides)", () => {
  const index = scenarioStepIndex([
    { id: "identify-objection", trainer_moves: ["probe-market"], learner_moves: ["state-case"] },
    { id: "debrief-gap", trainer_moves: ["coach-gap"], learner_moves: ["self-assess"] },
    { id: "set-next-step", trainer_moves: ["book-step"], learner_moves: ["self-assess"] },
    { id: "odd", trainer_moves: "not-a-list" },
  ]);
  expect(index.movesOf("identify-objection")).toEqual(["probe-market", "state-case"]);
  expect(index.movesOf("odd")).toEqual([]);
  expect(index.movesOf("missing")).toEqual([]);
  expect(index.stepOf("probe-market")).toBe("identify-objection");
  // A move shared by two steps resolves to the first, as listed in scenario.json.
  expect(index.stepOf("self-assess")).toBe("debrief-gap");
  expect(index.stepOf(undefined)).toBeUndefined();
});
