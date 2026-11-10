import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as twin from "@/lib/invite/twin";
import * as roleplay from "@/lib/invite/roleplay";
import * as org from "@/lib/invite/org";
import * as delivery from "@/lib/schedule-invite-emails";
import { MinutesError } from "@/lib/minutes";
import { assignTwin, assignRoleplay, inviteLearners, sendEmails } from "@/workflows/steps/learners";

const input = { org: { id: "org", slug: "org", name: "Org" }, by: { id: "trainer", name: "Trainer" }, agent: { id: "agent", name: "Agent", data: {} }, emails: ["learner@example.com"], minutes: 30 };
let twinSpy: ReturnType<typeof spyOn<typeof twin, "assignTwinLearners">>;
let roleplaySpy: ReturnType<typeof spyOn<typeof roleplay, "assignRoleplayLearners">>;
let orgSpy: ReturnType<typeof spyOn<typeof org, "inviteOrgLearners">>;
let queue: ReturnType<typeof spyOn<typeof delivery, "queueInviteEmails">>;
beforeEach(() => {
  twinSpy = spyOn(twin, "assignTwinLearners").mockResolvedValue({ stats: { added: 1, reactivated: 0, skipped: 0 }, emails: [] });
  roleplaySpy = spyOn(roleplay, "assignRoleplayLearners").mockResolvedValue({ stats: { added: 1, resent: 0, skipped: 0 }, emails: [] });
  orgSpy = spyOn(org, "inviteOrgLearners").mockResolvedValue({ invited: 1, failed: [], emails: [] });
  queue = spyOn(delivery, "queueInviteEmails").mockResolvedValue({ emailFailures: 0, emailsQueued: 0 });
});
afterEach(() => { for (const fn of [twinSpy, roleplaySpy, orgSpy, queue]) fn.mockRestore(); });

for (const [name, run, spy] of [
  ["assignTwin", assignTwin, () => twinSpy],
  ["assignRoleplay", assignRoleplay, () => roleplaySpy],
  ["inviteLearners", inviteLearners, () => orgSpy],
] as const) {
  test(`${name} adds ok on success and does not retry writes`, async () => {
    expect(await run(input)).toMatchObject({ ok: true, emails: [] });
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(spy()).toHaveBeenCalledWith(input);
    expect(run.maxRetries).toBe(0);
  });
  test(`${name} maps MinutesError and InviteError, but propagates unexpected errors`, async () => {
    for (const error of [new MinutesError("Need credits", 409), new org.InviteError("Already a member", 409), new MinutesError("Studio team", 400)]) {
      spy().mockRejectedValue(error);
      expect(await run(input)).toEqual({ ok: false, status: error.status, error: error.message });
    }
    const error = new Error("database unavailable");
    spy().mockRejectedValue(error);
    await expect(run(input)).rejects.toBe(error);
    expect(queue).not.toHaveBeenCalled();
  });
}
test("sendEmails delegates once without retrying", async () => {
  expect(await sendEmails("org", [])).toEqual({ emailFailures: 0, emailsQueued: 0 });
  expect(queue).toHaveBeenCalledTimes(1);
  expect(queue).toHaveBeenCalledWith("org", []);
  expect(sendEmails.maxRetries).toBe(0);
});
