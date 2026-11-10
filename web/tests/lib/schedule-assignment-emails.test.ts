import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { AssignmentEmail } from "@/workflows/assignment-emails";
import { progressRun } from "@/lib/run-progress";

let startFails = false;
const start = mock(async (..._args: unknown[]) => {
  if (startFails) throw new Error("missing SWC workflow transform");
  return { runId: "wrun_invites" };
});
const twin = mock(async (_args: unknown) => ({ success: true }));
const roleplay = mock(async (_args: unknown) => ({ success: false, error: "Resend unavailable" }));
mock.module("workflow/api", () => ({ start }));
mock.module("@/lib/email", () => ({ sendTwinAssignmentEmail: twin, sendRolePlayAssignmentEmail: roleplay }));
const { queueAssignmentEmails } = await import("@/lib/schedule-assignment-emails");
const { sendAssignmentEmails } = await import("@/workflows/assignment-emails");
const emails: AssignmentEmail[] = [
  { kind: "twin", args: { to: "a@example.com", twinName: "Twin", minutes: 30, practiceUrl: "https://example.com/t/twin" } },
  { kind: "roleplay", args: { to: "b@example.com", rolePlayName: "Practice", practiceUrl: "https://example.com/s/code" } },
];
let log: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  startFails = false;
  for (const fn of [start, twin, roleplay]) fn.mockClear();
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); });

test("queueAssignmentEmails empty batch neither starts a run nor sends inline", async () => {
  expect(await queueAssignmentEmails("org-1", [])).toEqual({ emailFailures: 0, emailsQueued: 0 });
  expect(start).not.toHaveBeenCalled();
  expect(twin).not.toHaveBeenCalled(); expect(roleplay).not.toHaveBeenCalled();
});

test("queueAssignmentEmails starts the workflow and returns an org-bound token without sending inline", async () => {
  const result = await queueAssignmentEmails("org-1", emails);
  expect(start).toHaveBeenCalledWith(sendAssignmentEmails, [emails]);
  expect(result).toEqual({ emailFailures: 0, emailsQueued: 2, emailProgress: expect.any(String) });
  expect(progressRun("org-1", result.emailProgress!)).toBe("wrun_invites");
  expect(progressRun("org-2", result.emailProgress!)).toBeNull();
  expect(twin).not.toHaveBeenCalled(); expect(roleplay).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test("queueAssignmentEmails falls back inline on start failure, routing both kinds and counting failed sends", async () => {
  startFails = true;
  expect(await queueAssignmentEmails("org-1", emails)).toEqual({ emailFailures: 1, emailsQueued: 0 });
  expect(start).toHaveBeenCalledTimes(1);
  expect(twin).toHaveBeenCalledTimes(1);
  expect(twin).toHaveBeenCalledWith(emails[0].args);
  expect(roleplay).toHaveBeenCalledTimes(1);
  expect(roleplay).toHaveBeenCalledWith(emails[1].args);
  expect(log).toHaveBeenCalledWith("[assignment-emails] workflow did not start; sending now:", "missing SWC workflow transform");
});

test("queueAssignmentEmails inline fallback reports zero failures when every send succeeds", async () => {
  startFails = true;
  expect(await queueAssignmentEmails("org-1", [emails[0]])).toEqual({ emailFailures: 0, emailsQueued: 0 });
  expect(twin).toHaveBeenCalledTimes(1);
  expect(twin).toHaveBeenCalledWith(emails[0].args);
});
