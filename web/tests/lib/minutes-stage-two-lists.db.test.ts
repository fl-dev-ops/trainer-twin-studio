import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureDeployment } from "@/lib/deployments";
import { listUsers } from "@/lib/learners";
import { creditsLeftFor, grantMinutes, recordSessionUsage, topUpOrg } from "@/lib/minutes";
import { LOW_LEARNER_MINUTES } from "@/lib/minutes-config";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

test("minutes-config LOW_LEARNER_MINUTES is 10", () => {
  expect(LOW_LEARNER_MINUTES).toBe(10);
});

describe.skipIf(!localMinutesDb)("credits stage two learner lists (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await f.clean(); });
  const caller = () => roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const give = async (minutes: number) => {
    await topUpOrg({ orgId: f.org.id, minutes, note: "stage two test" });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes });
  };
  const invite = async (emails: string[]) => {
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    await db.rolePlayAssignment.createMany({ data: emails.map((recipientEmail) => ({
      orgId: f.org.id, deploymentId: deployment.id, recipientEmail, assignedByUserId: f.trainer.id,
      shareCode: randomUUID(), expiresAt: new Date(Date.now() + 3600_000),
    })) });
  };

  test("creditsLeftFor normalizes emails and returns whole-minute left/given, including zero for unknown learners", async () => {
    await give(45);
    await db.user.update({ where: { id: f.learner.id }, data: { email: f.learner.email.toUpperCase() } });
    await recordSessionUsage((await f.session()).id); // 90 whole seconds used, 43.5 minutes left.
    const unknown = `unknown-${f.learner.email}`;
    expect(await creditsLeftFor(f.org.id, [f.learner.email, ` ${f.learner.email.toUpperCase()} `, unknown.toUpperCase()])).toEqual(new Map([
      [f.learner.email, { left: 43, given: 45 }], [unknown, { left: 0, given: 0 }],
    ]));
    expect(await creditsLeftFor(f.org.id, [])).toEqual(new Map());
  });

  test("listUsers and roleplay users.list expose the same whole-minute credits for case-mixed emails", async () => {
    await give(45);
    await db.user.update({ where: { id: f.learner.id }, data: { email: f.learner.email.toUpperCase() } });
    await invite([f.learner.email.toUpperCase()]);
    await recordSessionUsage((await f.session()).id);
    const users = (await listUsers(f.org.id)).filter((row) => row.email === f.learner.email);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ minutesLeft: 43, minutesGiven: 45, roleplaySessions: 1 });
    const roleplayUsers = (await caller().users.list()).filter((row) => row.email === f.learner.email);
    expect(roleplayUsers).toHaveLength(1);
    expect(roleplayUsers[0]).toMatchObject({ creditsLeft: 43, sessions: 1 });
  });

  test.each(["admin", "team"])("creditsLeftFor / listUsers / roleplay users.list return null for %s, even with a grant", async (role) => {
    await give(45);
    await invite([f.learner.email.toUpperCase()]);
    if (role === "admin") await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role: "team" } });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role } });
    await db.user.update({ where: { id: f.learner.id }, data: { email: f.learner.email.toUpperCase() } });
    expect(await creditsLeftFor(f.org.id, [f.learner.email.toUpperCase()])).toEqual(new Map([[f.learner.email, null]]));
    expect((await listUsers(f.org.id)).find((row) => row.email === f.learner.email)).toMatchObject({ minutesLeft: null, minutesGiven: null });
    expect((await caller().users.list()).find((row) => row.email === f.learner.email)).toMatchObject({ creditsLeft: null });
  });

  test("list credits are zero, not null, for uncredited assignment-only learners", async () => {
    const unknown = `unknown-${f.learner.email}`;
    await invite([unknown]);
    expect((await listUsers(f.org.id)).find((row) => row.email === unknown)).toMatchObject({ minutesLeft: 0, minutesGiven: 0 });
    expect((await caller().users.list()).find((row) => row.email === unknown)).toMatchObject({ creditsLeft: 0 });
  });

  test("creditsLeftFor / listUsers / roleplay users.list floor sub-minute balances to zero, preserving minutesGiven", async () => {
    await give(2);
    await invite([f.learner.email]);
    await recordSessionUsage((await f.session({ allowedSeconds: 120, endedAt: new Date("2026-01-01T00:01:01Z") })).id);
    expect(await creditsLeftFor(f.org.id, [f.learner.email])).toEqual(new Map([[f.learner.email, { left: 0, given: 2 }]]));
    expect((await listUsers(f.org.id)).find((row) => row.email === f.learner.email)).toMatchObject({ minutesLeft: 0, minutesGiven: 2 });
    expect((await caller().users.list()).find((row) => row.email === f.learner.email)).toMatchObject({ creditsLeft: 0 });
  });
});
