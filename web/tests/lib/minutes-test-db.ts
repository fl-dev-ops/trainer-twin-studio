// @ts-expect-error Bun test types are provided by the test runner, not Next.
import { beforeAll, afterAll, expect } from "bun:test";
import { setupServer } from "msw/node";
import { meteroidHandlers } from "../setup/meteroid";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

// Never use a remote database, or a fake left behind by another file's mock.module.
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "");
const realDb = typeof (db as { $transaction?: unknown }).$transaction === "function" && "minuteLedger" in db;
export const localMinutesDb = local && realDb;
export { db };

export function minutesFixture() {
  const id = `minutes-test-${randomUUID()}`;
  const org = { id, slug: id, name: "Minutes test" };
  const learner = { id: `${id}-learner`, name: "Learner", email: `${id}@example.com` };
  const trainer = { id: `${id}-trainer`, name: "Trainer", email: `${id}-trainer@example.com` };
  const roleplay = { id: `${id}-rp`, slug: `${id}-rp`, name: "Role play", data: {} };
  const twin = { id: `${id}-twin`, slug: `${id}-twin`, name: "Twin", data: {} };
  return {
    org, learner, trainer, roleplay, twin,
    async create() {
      await db.organization.create({ data: { ...org, createdAt: new Date() } });
      for (const [user, role] of [[learner, "user"], [trainer, "admin"]] as const) {
        await db.user.create({ data: { ...user, emailVerified: true } });
        await db.member.create({ data: { id: `${user.id}-member`, userId: user.id, organizationId: id, role, createdAt: new Date() } });
      }
      const persona = await db.persona.create({ data: { orgId: id, slug: id, name: "Persona", data: {}, isOwn: true } });
      for (const [agent, kind] of [[roleplay, "ROLEPLAY"], [twin, "TWIN"]] as const) {
        await db.agent.create({ data: { ...agent, kind, orgId: id, personaId: persona.id } });
      }
    },
    async clean() {
      await db.minuteLedger.deleteMany({ where: { orgId: id } });
      await db.interviewSession.deleteMany({ where: { orgId: id } });
      await db.deployment.deleteMany({ where: { orgId: id } });
      await db.agent.deleteMany({ where: { orgId: id } });
      await db.persona.deleteMany({ where: { orgId: id } });
      await db.organization.deleteMany({ where: { id } });
      await db.user.deleteMany({ where: { email: { contains: id, mode: "insensitive" } } });
    },
    session(fields: Partial<Prisma.InterviewSessionUncheckedCreateInput> = {}) {
      return db.interviewSession.create({ data: {
        orgId: id, userId: learner.id, agentId: roleplay.id, shareCode: randomUUID(),
        personaSlug: id, personaVersion: 1, agentSlug: roleplay.slug, agentVersion: 1,
        status: "completed", allowedSeconds: 600,
        startedAt: new Date("2026-01-01T00:00:00Z"), endedAt: new Date("2026-01-01T00:01:30.999Z"),
        ...fields,
      } });
    },
  };
}
export type MinutesFixture = ReturnType<typeof minutesFixture>;

export const meteroidServer = setupServer(...meteroidHandlers);
const unexpectedMeteroid: string[] = [];
meteroidServer.events.on("request:unhandled", ({ request }) => { if (request.url.includes("meteroid")) unexpectedMeteroid.push(request.url); });
beforeAll(() => meteroidServer.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => { meteroidServer.close(); expect(unexpectedMeteroid).toEqual([]); });
