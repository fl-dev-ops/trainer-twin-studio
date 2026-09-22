import assert from "node:assert/strict";
import test from "node:test";
import { isSessionReportEligible } from "../../../lib/session-report-jobs";

test("only completed sessions with an available report slot are eligible", () => {
  assert.equal(isSessionReportEligible("completed", "none"), true);
  assert.equal(isSessionReportEligible("completed", "failed"), true);
  assert.equal(isSessionReportEligible("completed", null), true);
  assert.equal(isSessionReportEligible("completed", "generating"), false);
  assert.equal(isSessionReportEligible("completed", "completed"), false);
  assert.equal(isSessionReportEligible("abandoned", "none"), false);
  assert.equal(isSessionReportEligible("active", "none"), false);
});
