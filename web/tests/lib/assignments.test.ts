import assert from "node:assert/strict";
import test from "node:test";
import { assignmentMatchesUser } from "../../lib/assignments";

test("email assignments require the authenticated recipient while legacy assignments keep member ownership", () => {
  assert.equal(
    assignmentMatchesUser(
      { recipientEmail: "Learner@Example.com", member: null },
      { id: "learner", email: "learner@example.com" },
    ),
    true,
  );
  assert.equal(
    assignmentMatchesUser(
      { recipientEmail: "learner@example.com", member: null },
      { id: "other", email: "other@example.com" },
    ),
    false,
  );
  assert.equal(
    assignmentMatchesUser(
      { recipientEmail: "learner@example.com", member: { userId: "legacy" } },
      { id: "other", email: "learner@example.com" },
    ),
    false,
  );
});
