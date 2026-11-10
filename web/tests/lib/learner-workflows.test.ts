import { beforeEach, expect, mock, test } from "bun:test";
import type { OrgInviteInput } from "@/lib/invite/org";
import type { TwinAssignInput } from "@/lib/invite/twin";
import type { RoleplayAssignInput } from "@/lib/invite/roleplay";
import type { InviteEmail } from "@/workflows/invite-emails";

const emails: InviteEmail[] = [{ kind: "invitation", args: { to: "learner@example.com", organizationName: "Org", inviteUrl: "https://org.example.com/" } }];
const refusal = { ok: false as const, status: 409, error: "Not enough credits" };
let refused = false;
const assignTwin = mock(async (_input: TwinAssignInput) => refused ? refusal : { ok: true as const, stats: { added: 1, skipped: 0 }, emails });
const assignRoleplay = mock(async (_input: RoleplayAssignInput) => refused ? refusal : { ok: true as const, stats: { added: 1, skipped: 0 }, emails });
const inviteLearners = mock(async (_input: OrgInviteInput) => refused ? refusal : { ok: true as const, invited: 1, failed: [], emails });
const delivery = { emailFailures: 0, emailsQueued: 1, emailProgress: "signed-token" };
const sendEmails = mock(async (_orgId: string, _emails: InviteEmail[]) => delivery);
mock.module("@/workflows/steps/learners", () => ({ assignTwin, assignRoleplay, inviteLearners, sendEmails }));
const { assignTwinToLearners } = await import("@/workflows/assign-twin");
const { assignRoleplayToLearners } = await import("@/workflows/assign-roleplay");
const { inviteOrgLearners } = await import("@/workflows/invite-org-learners");
const input = { org: { id: "org", slug: "org", name: "Org" }, by: { id: "trainer", name: "Trainer" }, agent: { id: "agent", name: "Agent", data: {} }, emails: ["learner@example.com"], minutes: 30 };
beforeEach(() => { refused = false; for (const fn of [assignTwin, assignRoleplay, inviteLearners, sendEmails]) fn.mockClear(); });

for (const [name, run, step, stats] of [
  ["assign-twin", assignTwinToLearners, assignTwin, { added: 1, skipped: 0 }],
  ["assign-roleplay", assignRoleplayToLearners, assignRoleplay, { added: 1, skipped: 0 }],
  ["invite-org-learners", inviteOrgLearners, inviteLearners, { invited: 1, failed: [] }],
] as const) {
  test(`${name} assigns once then queues exactly the returned emails once`, async () => {
    expect(await run(input)).toEqual({ ok: true, ...stats, ...delivery });
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledWith(input);
    expect(sendEmails).toHaveBeenCalledTimes(1);
    expect(sendEmails).toHaveBeenCalledWith("org", emails);
    expect(step.mock.invocationCallOrder[0]).toBeLessThan(sendEmails.mock.invocationCallOrder[0]);
  });
  test(`${name} returns refusal unchanged without queueing`, async () => {
    refused = true;
    expect(await run(input)).toBe(refusal);
    expect(step).toHaveBeenCalledTimes(1);
    expect(sendEmails).not.toHaveBeenCalled();
  });
}
