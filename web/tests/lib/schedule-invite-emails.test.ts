import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { InviteEmail } from "@/workflows/invite-emails";
import { progressRun } from "@/lib/run-progress";

let startFails = false;
const start = mock(async (..._args: unknown[]) => {
  if (startFails) throw new Error("missing SWC workflow transform");
  return { runId: "wrun_invites" };
});
const twin = mock(async (_args: unknown) => ({ success: true }));
const invitation = mock(async (_args: unknown) => ({ success: true }));
const roleplay = mock(async (_args: unknown) => ({ success: false, error: "Resend unavailable" }));
mock.module("workflow/api", () => ({ start }));
mock.module("@/lib/email", () => ({ sendTwinAssignmentEmail: twin, sendRolePlayAssignmentEmail: roleplay, sendInvitationEmail: invitation }));
const { queueInviteEmails, deliverInviteEmail } = await import("@/lib/schedule-invite-emails");
const { sendInviteEmails } = await import("@/workflows/invite-emails");
const emails: InviteEmail[] = [
  { kind: "twin", args: { to: "a@example.com", twinName: "Twin", minutes: 30, practiceUrl: "https://example.com/t/twin" } },
  { kind: "roleplay", args: { to: "b@example.com", rolePlayName: "Practice", practiceUrl: "https://example.com/s/code" } },
];
let log: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  startFails = false;
  for (const fn of [start, twin, roleplay, invitation]) fn.mockClear();
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); });

test("queueInviteEmails empty batch neither starts a run nor sends inline", async () => {
  expect(await queueInviteEmails("org-1", [])).toEqual({ emailFailures: 0, emailsQueued: 0 });
  expect(start).not.toHaveBeenCalled();
  expect(twin).not.toHaveBeenCalled(); expect(roleplay).not.toHaveBeenCalled();
});

test("queueInviteEmails starts the workflow and returns an org-bound token without sending inline", async () => {
  const result = await queueInviteEmails("org-1", emails);
  expect(start).toHaveBeenCalledWith(sendInviteEmails, [emails]);
  expect(result).toEqual({ emailFailures: 0, emailsQueued: 2, emailProgress: expect.any(String) });
  expect(progressRun("org-1", result.emailProgress!)).toBe("wrun_invites");
  expect(progressRun("org-2", result.emailProgress!)).toBeNull();
  expect(twin).not.toHaveBeenCalled(); expect(roleplay).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test("queueInviteEmails falls back inline on start failure, routing both kinds and counting failed sends", async () => {
  startFails = true;
  expect(await queueInviteEmails("org-1", emails)).toEqual({ emailFailures: 1, emailsQueued: 0 });
  expect(start).toHaveBeenCalledTimes(1);
  expect(twin).toHaveBeenCalledTimes(1);
  expect(twin).toHaveBeenCalledWith({ ...emails[0].args, idempotencyKey: undefined });
  expect(roleplay).toHaveBeenCalledTimes(1);
  expect(roleplay).toHaveBeenCalledWith({ ...emails[1].args, idempotencyKey: undefined });
  expect(log).toHaveBeenCalledWith("[invite-emails] workflow did not start; sending now:", "missing SWC workflow transform");
});

test("queueInviteEmails inline fallback reports zero failures when every send succeeds", async () => {
  startFails = true;
  expect(await queueInviteEmails("org-1", [emails[0]])).toEqual({ emailFailures: 0, emailsQueued: 0 });
  expect(twin).toHaveBeenCalledTimes(1);
  expect(twin).toHaveBeenCalledWith({ ...emails[0].args, idempotencyKey: undefined });
});

test("deliverInviteEmail successful invitation sends inline with its key, without a workflow", async () => {
  const email = { kind: "invitation" as const, idempotencyKey: "invitation:1:123", args: { to: "new@example.com", organizationName: "Org", inviteUrl: "https://example.com/join" } };
  expect(await deliverInviteEmail(email)).toEqual({ sent: true });
  expect(invitation).toHaveBeenCalledWith({ ...email.args, idempotencyKey: email.idempotencyKey });
  expect(start).not.toHaveBeenCalled();
});
test("deliverInviteEmail failure queues exactly the same email and key, returning sent false", async () => {
  const email = { ...emails[1], idempotencyKey: "assignment:1:code" };
  expect(await deliverInviteEmail(email)).toEqual({ sent: false });
  expect(roleplay).toHaveBeenCalledWith({ ...email.args, idempotencyKey: email.idempotencyKey });
  expect(start).toHaveBeenCalledWith(sendInviteEmails, [[email]]);
});
test("deliverInviteEmail retry enqueue failure still returns sent false", async () => {
  startFails = true;
  expect(await deliverInviteEmail({ ...emails[1], idempotencyKey: "assignment:1:code" })).toEqual({ sent: false });
  expect(start).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith("[invite-emails] could not queue a retry:", "missing SWC workflow transform");
});
