import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSessionReportStatus } from "../../../lib/session-report";

test("session report status never presents missing feedback as completed", () => {
  assert.equal(normalizeSessionReportStatus("completed", false), "none");
  assert.equal(normalizeSessionReportStatus("generating", false), "generating");
  assert.equal(normalizeSessionReportStatus("failed", false), "failed");
  assert.equal(normalizeSessionReportStatus("none", false), "none");
  assert.equal(normalizeSessionReportStatus("none", true), "completed");
});
