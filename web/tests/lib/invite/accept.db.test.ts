import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { auth } from "@/lib/auth";
import { acceptLearnerInvite } from "@/lib/invite/accept";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../minutes-test-db";

describe.skipIf(!localMinutesDb)("accepting a learner's org invite on the org home (local database)", () => {
  let f: MinutesFixture;
  let accept: ReturnType<typeof spyOn<typeof auth.api, "acceptInvitation">>;
  const newcomer = () => ({ id: `${f.org.id}-newcomer`, name: "New", email: `${f.org.id}-new@example.com` });
  const invite = (fields: { email?: string; role?: string; status?: string; expiresAt?: Date } = {}) =>
    db.invitation.create({ data: {
      id: `${f.org.id}-inv-${Math.random().toString(36).slice(2)}`,
      organizationId: f.org.id,
      email: fields.email ?? newcomer().email,
      role: fields.role ?? "user",
      status: fields.status ?? "pending",
      expiresAt: fields.expiresAt ?? new Date(Date.now() + 60_000),
      inviterId: f.trainer.id,
    } });
  const run = (user = newcomer()) => acceptLearnerInvite({ orgId: f.org.id, user, headers: new Headers() });

  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    await db.user.create({ data: { ...newcomer(), emailVerified: true } });
    accept = spyOn(auth.api, "acceptInvitation").mockResolvedValue(null as never);
  });
  afterEach(async () => { accept?.mockRestore(); await db.user.deleteMany({ where: { id: newcomer().id } }); await f.clean(); });

  test("a pending learner invite for this email (any case) is accepted", async () => {
    const invitation = await invite({ email: newcomer().email.toUpperCase() });
    expect(await run()).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0][0]).toMatchObject({ body: { invitationId: invitation.id } });
  });

  test("members, expired, used and studio invites are left alone", async () => {
    await invite({ email: f.learner.email });
    expect(await run(f.learner)).toBe(false); // already a member
    await invite({ expiresAt: new Date(Date.now() - 1000) });
    await invite({ status: "accepted" });
    await invite({ role: "team" });
    expect(await run()).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  test("a failed accept doesn't break the page", async () => {
    accept.mockRejectedValueOnce(new Error("email mismatch"));
    const error = spyOn(console, "error").mockImplementation(() => {});
    await invite();
    expect(await run()).toBe(false);
    error.mockRestore();
  });
});
