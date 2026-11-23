// @ts-expect-error Bun test types are provided by the test runner, not Next.
import { beforeAll, afterAll, expect } from "bun:test";
import { setupServer } from "msw/node";
import { meteroidHandlers } from "../setup/meteroid";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { voicePrefix } from "@/lib/s3";
import { testDatabaseUrl } from "../setup/test-db-url";
import type { Prisma } from "@/lib/generated/prisma/client";
import { createBot, listBots, saveBotPublic, type BotPublicPatch } from "@/lib/bots";

// Never use a remote database, or a fake left behind by another file's mock.module.
const testUrl = testDatabaseUrl();
const local = testUrl !== null && testUrl === process.env.DATABASE_URL;
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
  const fixtureVoiceId = `${id}-voice`;
  return {
    org, learner, trainer, roleplay, twin,
    async create(options: boolean | { learnerMember?: boolean; voice?: boolean } = true) {
      const { learnerMember = true, voice = false } = typeof options === "boolean" ? { learnerMember: options } : options;
      // Publish the org with its admin atomically: parallel invariant checks must never see an admin-less fixture.
      await db.$transaction(async (tx) => {
        for (const user of [learner, trainer]) await tx.user.create({ data: { ...user, emailVerified: true } });
        await tx.organization.create({ data: { ...org, createdAt: new Date(), members: { create: [
          { id: `${trainer.id}-member`, userId: trainer.id, role: "admin", createdAt: new Date() },
          ...(learnerMember ? [{ id: `${learner.id}-member`, userId: learner.id, role: "user", createdAt: new Date() }] : []),
        ] } } });
      });
      const voiceId = voice ? fixtureVoiceId : null;
      if (voiceId) await db.voice.create({ data: {
        id: voiceId, orgId: id, name: "Fixture voice", kind: "cloned", status: "ready",
        s3AudioKey: `${voicePrefix(id, voiceId)}/reference.wav`,
      } });
      const persona = await db.persona.create({ data: { orgId: id, slug: id, name: "Persona", data: {}, isOwn: true, voiceId } });
      for (const [agent, kind] of [[roleplay, "ROLEPLAY"], [twin, "TWIN"]] as const) {
        await db.agent.create({ data: { ...agent, kind, orgId: id, personaId: persona.id } });
      }
    },
    async clean() {
      await db.minuteLedger.deleteMany({ where: { orgId: id } });
      await db.interviewSession.deleteMany({ where: { orgId: id } });
      await db.deployment.deleteMany({ where: { orgId: id } });
      await db.agent.deleteMany({ where: { orgId: id } });
      await db.specVersion.deleteMany({ where: { orgId: id } });
      await db.persona.deleteMany({ where: { orgId: id } });
      await db.voice.deleteMany({ where: { id: fixtureVoiceId, orgId: id } });
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

/**
 * The fixture org's bot (lib/bots): made on first use, speaking as the fixture twin's persona; later calls change its
 * public call and widget settings.
 */
export async function setTwinPublic(
  f: { org: { id: string }; twin: { id: string } },
  settings: BotPublicPatch,
) {
  return db.$transaction(async (tx) => {
    let bot = (await listBots(f.org.id, tx))[0];
    if (!bot) {
      const twin = await tx.agent.findUniqueOrThrow({ where: { id: f.twin.id }, select: { personaId: true, name: true, data: true } });
      const objective = (twin.data as { objective?: string } | null)?.objective ?? "Talk with visitors.";
      bot = (await createBot(f.org.id, { personaId: twin.personaId, name: twin.name, objective }, tx))!;
    }
    return saveBotPublic(bot, settings, tx);
  });
}
