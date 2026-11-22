import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { POST as studio } from "@/app/api/internal/copilot-studio/route";
import * as knowledge from "@/app/api/internal/knowledge-sources/route";
import { POST as scenario } from "@/app/api/internal/scenarios/route";
import { POST as runs } from "@/app/api/internal/scenario-runs/route";
import { POST as skill } from "@/app/api/internal/twin-skills/route";
import * as s3 from "@/lib/s3";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";

const routes = { studio, knowledge: knowledge.GET, scenario, runs, skill };

describe.skipIf(!localMinutesDb)("Copilot least-privilege boundary (real Postgres)", () => {
  const org = minutesFixture(), other = minutesFixture();
  const secret = "copilot-boundary-test";
  const previous = process.env.SCENARIO_INGEST_SECRET;
  beforeAll(async () => {
    process.env.SCENARIO_INGEST_SECRET = secret;
    await org.create({ voice: true });
    await other.create({ voice: true });
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.SCENARIO_INGEST_SECRET;
    else process.env.SCENARIO_INGEST_SECRET = previous;
    await org.clean(); await other.clean();
  });
  function call(route: keyof typeof routes, body: unknown = {}, headers: Record<string, string> = {}) {
    return routes[route](new Request(`https://local.test/${route}`, {
      headers: { authorization: `Bearer ${secret}`, "x-trainertwin-org-id": org.org.id, "x-trainertwin-user-id": org.trainer.id, ...headers },
      ...(route === "knowledge" ? {} : { method: "POST", body: JSON.stringify(body) }),
    }));
  }
  const action = (name: string, fields: Record<string, unknown> = {}) => call("studio", { action: name, ...fields });

  test("all five routes require the service credential AND current enabled studio membership", async () => {
    const member = `${org.learner.id}-member`;
    await db.member.update({ where: { id: member }, data: { role: "team" } });
    try {
      expect((await call("studio", { action: "context" }, { "x-trainertwin-user-id": org.learner.id })).status).toBe(200);
      await db.member.update({ where: { id: member }, data: { disabledAt: new Date() } });
      for (const route of Object.keys(routes) as (keyof typeof routes)[]) {
        expect((await call(route, {}, { authorization: "Bearer wrong" })).status).toBe(401);
        expect((await call(route, {}, { "x-trainertwin-user-id": "" })).status).toBe(400);
        expect((await call(route, {}, { "x-trainertwin-user-id": org.learner.id })).status).toBe(403);
        expect((await call(route, {}, { "x-trainertwin-org-id": other.org.id })).status).toBe(403);
        expect((await call(route, {}, { "x-trainertwin-user-id": other.learner.id })).status).toBe(403);
      }
    } finally {
      await db.member.update({ where: { id: member }, data: { role: "user", disabledAt: null } });
    }
    expect((await call("knowledge", {}, { "x-trainertwin-user-id": org.learner.id })).status).toBe(403);
  });

  test("main twin creation is repeat-safe, and twin and role-play edits stay scoped", async () => {
    const make = () => action("createTwin", { persona: org.org.slug });
    const twins = await Promise.all([make(), make()].map(async (response) => {
      const res = await response;
      expect(res.status).toBe(200);
      return res.json() as Promise<{ slug: string; created: boolean }>;
    }));
    expect(twins.map((t) => t.created).sort()).toEqual([false, true]);
    expect(twins[0].slug).toBe(twins[1].slug);
    expect((await action("createTwin", { persona: other.org.slug })).status).toBe(404);
    expect((await action("updateTwin", { slug: twins[0].slug, name: "Sales helper" })).status).toBe(200);
    expect(await db.agent.findUniqueOrThrow({ where: { slug: twins[0].slug } })).toMatchObject({ name: "Sales helper", version: 2 });
    expect((await action("updateRoleplay", { slug: org.roleplay.slug, tools: { knowledge: true }, before: { preUpload: true, preUploadRequired: true } })).status).toBe(200);
    expect(await db.agent.findUniqueOrThrow({ where: { id: org.roleplay.id } })).toMatchObject({ data: { tools: { knowledge: true }, before: { preUploadRequired: true } } });
    expect((await action("updateTwin", { slug: other.twin.slug, name: "No" })).status).toBe(404);
    expect((await action("updateRoleplay", { slug: other.roleplay.slug, tools: { knowledge: true } })).status).toBe(404);
    expect((await action("updateRoleplay", { slug: twins[0].slug, tools: { knowledge: true } })).status).toBe(404);
  });

  test("creates and updates only role-play personas; another org's voice or persona cannot be selected", async () => {
    const fields = { name: "Practice Buyer", role: "Buyer", about: "Calm", voiceId: `${org.org.id}-voice` };
    expect((await action("createPersona", fields)).status).toBe(200);
    const change = (patch: Record<string, unknown>) => action("updatePersona", { slug: "practice-buyer", ...patch });
    expect((await change({ about: "Curious" })).status).toBe(200);
    const row = await db.persona.findUniqueOrThrow({ where: { orgId_slug: { orgId: org.org.id, slug: "practice-buyer" } } });
    expect(row).toMatchObject({ name: fields.name, voiceId: fields.voiceId, version: 2, data: { role: fields.role, background: "Curious" } });
    expect((await change({ name: "Do not save", voiceId: `${other.org.id}-voice` })).status).toBe(404);
    expect((await change({ isOwn: true })).status).toBe(400);
    expect((await change({ slug: org.org.slug, name: "Do not save" })).status).toBe(403);
    expect((await change({ slug: other.org.slug, name: "Do not save" })).status).toBe(404);
    expect(await db.persona.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  test("user list shows roles and only current assignments, without exposing account details or links", async () => {
    const { learner, trainer } = org;
    const memberId = `${learner.id}-member`;
    const deployment = await db.deployment.create({ data: { orgId: org.org.id, agentId: org.roleplay.id, publicKey: `${org.org.id}-public` } });
    const link = await db.rolePlayAssignment.create({ data: { orgId: org.org.id, deploymentId: deployment.id, memberId, assignedByUserId: trainer.id, shareCode: `${org.org.id}-roleplay-secret`, expiresAt: new Date("2099-01-01") } });
    const twin = await db.twinAssignment.create({ data: { orgId: org.org.id, userId: learner.id, agentId: org.twin.id, shareCode: `${org.org.id}-twin-secret`, minutesLimit: 30 } });
    const list = async (name?: string) => {
      const res = await action("listUsers", name ? { name } : {});
      expect(res.status).toBe(200);
      return res.json();
    };
    const staff = { name: trainer.name, role: "admin", disabled: false, twins: [], roleplays: [] };
    const active = { name: learner.name, role: "learner", disabled: false, twins: [{ name: org.twin.name, slug: org.twin.slug }], roleplays: [{ name: org.roleplay.name, slug: org.roleplay.slug }] };
    const roster = await list() as { users: { name: string }[]; nextOffset: number | null };
    expect(roster.users.sort((a, b) => a.name.localeCompare(b.name))).toEqual([active, staff]);
    expect(roster.nextOffset).toBeNull();
    expect(await list("learN")).toEqual({ users: [active], nextOffset: null });
    expect(await list("%_")).toEqual({ users: [], nextOffset: null });
    await db.rolePlayAssignment.update({ where: { id: link.id }, data: { status: "used", expiresAt: new Date(0) } });
    expect(await list("Learner")).toEqual({ users: [active], nextOffset: null });
    for (const header of [{ "x-trainertwin-user-id": learner.id }, { "x-trainertwin-org-id": other.org.id }]) {
      expect((await call("studio", { action: "listUsers" }, header)).status).toBe(403);
    }
    expect((await action("listUsers", { orgId: other.org.id })).status).toBe(400);
    expect((await action("listUsers", { offset: -1 })).status).toBe(400);
    await db.twinAssignment.update({ where: { id: twin.id }, data: { accessUntil: new Date(0) } });
    await db.deployment.update({ where: { id: deployment.id }, data: { status: "disabled" } });
    const empty = { ...active, twins: [], roleplays: [] };
    expect(await list("Learner")).toEqual({ users: [empty], nextOffset: null });
    await db.twinAssignment.update({ where: { id: twin.id }, data: { accessUntil: null, status: "revoked" } });
    await db.deployment.update({ where: { id: deployment.id }, data: { status: "active" } });
    await db.rolePlayAssignment.update({ where: { id: link.id }, data: { status: "cancelled" } });
    expect(await list("Learner")).toEqual({ users: [empty], nextOffset: null });
    await db.twinAssignment.update({ where: { id: twin.id }, data: { status: "active" } });
    await db.rolePlayAssignment.update({ where: { id: link.id }, data: { status: "used" } });
    const agentIds = [org.twin.id, org.roleplay.id];
    await db.agent.updateMany({ where: { id: { in: agentIds } }, data: { archivedAt: new Date() } });
    expect(await list("Learner")).toEqual({ users: [empty], nextOffset: null });
    await db.agent.updateMany({ where: { id: { in: agentIds } }, data: { archivedAt: null } });
    await db.member.update({ where: { id: memberId }, data: { role: "team" } });
    expect(await list("Learner")).toEqual({ users: [{ ...empty, role: "team" }], nextOffset: null });
    await db.member.update({ where: { id: memberId }, data: { role: "user", disabledAt: new Date() } });
    expect(await list("Learner")).toEqual({ users: [{ ...empty, disabled: true }], nextOffset: null });
    await db.user.update({ where: { id: learner.id }, data: { name: learner.email } });
    expect((await list()).users).toContainEqual({ ...empty, name: "Unnamed user", disabled: true });
    expect(await list(learner.email)).toEqual({ users: [], nextOffset: null });
  });

  test("roster pages are bounded, stable, and keep the name filter", async () => {
    const users = Array.from({ length: 26 }, (_, i) => ({
      id: `${org.org.id}-roster-${i}`, email: `${org.org.id}-roster-${i}@example.com`, name: `Roster ${String(i).padStart(2, "0")}`,
    }));
    await db.$transaction([
      db.user.createMany({ data: users }),
      db.member.createMany({ data: users.map((person, i) => ({ id: `${person.id}-member`, userId: person.id, organizationId: org.org.id, role: "user", createdAt: new Date(1000 + i) })) }),
    ]);
    const first = await (await action("listUsers", { name: "roster" })).json() as { users: { name: string }[]; nextOffset: number };
    expect(first.nextOffset).toBe(25);
    expect(first.users.map(({ name }) => name)).toEqual(users.slice(0, 25).map(({ name }) => name));
    expect(await (await action("listUsers", { name: "roster", offset: first.nextOffset })).json()).toEqual({ users: [{ name: "Roster 25", role: "learner", disabled: false, twins: [], roleplays: [] }], nextOffset: null });
  });

  test("knowledge lists and signs only this org's files; no management actions are accepted", async () => {
    const doc = async (orgId: string, title: string, status = "indexed") => {
      const kb = await db.knowledgeBase.upsert({ where: { orgId_slug: { orgId, slug: "brain" } }, create: { orgId, slug: "brain", name: "Brain" }, update: {} });
      return db.knowledgeDocument.create({ data: { kbId: kb.id, slug: title, title, status, ext: "md", size: 2, s3SourceKey: `${orgId}/${title}`, s3MarkdownKey: `${orgId}/${title}.md` } });
    };
    const own = await doc(org.org.id, "Own"), failed = await doc(org.org.id, "Failed", "failed"), foreign = await doc(other.org.id, "Foreign");
    const signing = spyOn(s3, "presignedGetUrl").mockImplementation(async (key) => `https://s3.invalid/${key}`);
    try {
      expect(await (await action("listKnowledge")).json()).toMatchObject({ docs: [{ id: own.id, title: "Own" }] });
      expect(await (await call("knowledge")).json()).toMatchObject({ files: [{ docId: own.id, title: "Own" }] });
      expect(signing.mock.calls).toEqual([[own.s3MarkdownKey, 900]]);
      for (const name of ["inviteLearners", "archive", "restore", "deletePersona", "updateKnowledge", "deleteKnowledge", "updateCredits", "listMembers"]) {
        expect((await action(name)).status).toBe(400);
      }
      expect(await db.knowledgeDocument.count({ where: { id: { in: [own.id, foreign.id, failed.id] } } })).toBe(3);
    } finally { signing.mockRestore(); }
  });
});
