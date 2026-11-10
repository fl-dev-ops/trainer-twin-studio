import { expect, test } from "bun:test";
import { assignmentMatchesUser } from "@/lib/assignments";

test("role-play ownership is by the member's account, never the submitted email", () => {
  const assignment = { member: { userId: "learner" } };
  expect(assignmentMatchesUser(assignment, { id: "learner", email: "changed@example.com" })).toBe(true);
  expect(assignmentMatchesUser(assignment, { id: "other", email: "learner@example.com" })).toBe(false);
});
