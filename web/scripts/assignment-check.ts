import assert from "node:assert/strict";
import { assignmentChanges } from "../lib/assignments";

assert.deepEqual(assignmentChanges(["a", "b"], ["b", "c", "c"]), {
  requested: ["b", "c"],
  added: ["c"],
  removed: ["a"],
});
assert.deepEqual(assignmentChanges(["a"], ["a"]), {
  requested: ["a"],
  added: [],
  removed: [],
});

console.log("assignment reconciliation checks passed");
