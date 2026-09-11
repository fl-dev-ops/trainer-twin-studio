import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionEndStatus } from "./interview-sessions";

test("browser finalization closes active sessions without downgrading completed ones", () => {
  assert.equal(resolveSessionEndStatus("active", "abandoned"), "abandoned");
  assert.equal(resolveSessionEndStatus("active", "completed"), "completed");
  assert.equal(resolveSessionEndStatus("completed", "abandoned"), "completed");
});
