import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as delivery from "@/lib/schedule-invite-emails";
import { emailOrgInvitation } from "@/lib/invite/org-hooks";
import { learnerInviteUrl, teamInviteUrl } from "@/lib/invite/links";

const send = spyOn(delivery, "deliverInviteEmail").mockResolvedValue({ sent: false, queued: true });
afterEach(() => { send.mockClear(); });
afterAll(() => { send.mockRestore(); });

for (const [role, inviter, name] of [
  ["team", { user: { name: "Nested trainer" } }, "Nested trainer"],
  ["user", { name: "Trainer" }, "Trainer"],
  ["admin", undefined, "Your team"],
] as const) {
  test(`emailOrgInvitation ${role} delegates to retrying delivery with its own invitation key`, async () => {
    const before = Date.now();
    await emailOrgInvitation({ id: "invite-id", email: "person@example.com", role, organization: { name: "Org", slug: "org" }, inviter });
    expect(send).toHaveBeenCalledTimes(1);
    const [email] = send.mock.calls[0];
    expect(email).toEqual({ kind: "invitation", idempotencyKey: expect.stringMatching(/^invitation:invite-id:\d+$/), args: {
      to: "person@example.com", organizationName: "Org", inviterName: name,
      inviteUrl: role === "user" ? learnerInviteUrl("org") : teamInviteUrl("invite-id"),
    } });
    const timestamp = Number(email.idempotencyKey!.split(":").at(-1));
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });
}
