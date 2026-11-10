import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { progressRun, progressToken } from "@/lib/run-progress";

const originalSecret = process.env.BETTER_AUTH_SECRET;
beforeEach(() => { process.env.BETTER_AUTH_SECRET = "test-progress-secret"; });
afterAll(() => {
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalSecret;
});

test("progressToken uses org-bound HMAC-SHA256 base64url and round trips the run ID", () => {
  const signature = createHmac("sha256", "test-progress-secret").update("run:org-1:wrun_1").digest("base64url");
  const token = progressToken("org-1", "wrun_1");
  expect(token).toBe(`wrun_1.${signature}`);
  expect(progressRun("org-1", token)).toBe("wrun_1");
  expect(progressToken("org-1", "wrun_1")).toBe(token);
});

test("progressRun refuses another org or a changed signing secret", () => {
  const token = progressToken("org-1", "wrun_1");
  expect(progressRun("org-2", token)).toBeNull();
  process.env.BETTER_AUTH_SECRET = "other-secret";
  expect(progressRun("org-1", token)).toBeNull();
});

test("progressRun refuses tampered run IDs and equal-length or truncated signatures", () => {
  const token = progressToken("org-1", "wrun_1");
  const [runId, signature] = token.split(".");
  expect(progressRun("org-1", token.replace(runId, "wrun_2"))).toBeNull();
  expect(progressRun("org-1", `${runId}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`)).toBeNull();
  expect(progressRun("org-1", token.slice(0, -1))).toBeNull();
});

test.each(["", "wrun_1", ".signature", "wrun_1."])("progressRun refuses malformed token %j", (token) => {
  expect(progressRun("org-1", token)).toBeNull();
});
