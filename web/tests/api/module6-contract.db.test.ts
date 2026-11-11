import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as database from "@/lib/db";
import * as externalApi from "@/lib/external-api";
import * as members from "@/lib/members";
import * as org from "@/lib/org";
import { auth } from "@/lib/auth";
import { MainCollectionService } from "@/lib/main-collection";
import { beforeSettings } from "@/lib/context-upload";
import { ensureDeployment } from "@/lib/deployments";
import { DELETE as disableUser, PATCH as renameUser } from "@/app/api/v1/users/[id]/route";
import { DELETE as deleteAssignment } from "@/app/api/v1/assignments/[id]/route";
import { DELETE as dashboardDelete } from "@/app/api/role-play/[slug]/assignments/route";
import { POST as createKey } from "@/app/api/developer/api-keys/route";
import { updateTwin } from "@/lib/twin/manage";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

// Real services and advisory locks; only external storage and vector indexing are replaced.
const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({ ...s3, s3Configured: true, putObject: async (key: string, body: string) => { files.set(key, body); } }));
const { ingestScenario } = await import("@/lib/scenario-ingest");
const { runCopilotStudio } = await import("@/lib/copilot-studio");
const { updateRoleplay } = await import("@/lib/roleplay/manage");

describe.skipIf(!localMinutesDb)("Module 6 REST retries, account ownership and copilot save locks (real Postgres)", () => {
  let f: MinutesFixture; let other: MinutesFixture;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture(); await f.create(); await other.create(); files.clear();
    spies.push(
      spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org, trainer: { memberId: `${f.trainer.id}-member`, userId: f.trainer.id, ...f.trainer, image: null, role: "admin", disabled: false, disabledAt: null, addedAt: new Date() }, actorUserId: f.trainer.id, keyId: "test-key" }),
      spyOn(org, "studioOrRefusal").mockResolvedValue({ ...f.org, accentColor: null, role: "admin", user: f.trainer }),
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, _version, items) => items.length),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
    );
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    for (const fixture of [other, f]) {
      await db.apikey.deleteMany({ where: { referenceId: fixture.org.id } });
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
  });
  const request = (method: string, body?: unknown) => new Request("https://test/api/v1/resource", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const learner = () => db.user.findUniqueOrThrow({ where: { id: f.learner.id } });
  const twin = () => db.agent.findUniqueOrThrow({ where: { id: f.twin.id } });
  const versions = () => db.specVersion.findMany({ where: { orgId: f.org.id, entitySlug: f.twin.slug }, orderBy: { version: "asc" } });

  test("DELETE /users retry returns 204 twice and calls setMemberDisabled again without destroying history", async () => {
    const history = await f.session();
    const disable = spyOn(members, "setMemberDisabled"); spies.push(disable);
    const first = await disableUser(request("DELETE"), params(f.learner.id)); expect(first.status).toBe(204); expect(await first.text()).toBe("");
    const disabled = await db.member.findUniqueOrThrow({ where: { id: `${f.learner.id}-member` } }); expect(disabled.disabledAt).toBeInstanceOf(Date);
    const retry = await disableUser(request("DELETE"), params(f.learner.id)); expect(retry.status).toBe(204); expect(await retry.text()).toBe("");
    expect(disable).toHaveBeenCalledTimes(2);
    for (const [input] of disable.mock.calls) expect(input).toEqual({ orgId: f.org.id, memberId: disabled.id, actorUserId: f.trainer.id, disabled: true });
    expect(await db.member.findUniqueOrThrow({ where: { id: disabled.id } })).toEqual(disabled);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history);
    expect(await learner()).toMatchObject(f.learner);
  });
  test("DELETE /users refuses not_found for a team member and unknown account without calling disable", async () => {
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role: "team" } });
    const disable = spyOn(members, "setMemberDisabled"); spies.push(disable);
    for (const id of [f.learner.id, `${f.org.id}-unknown`]) {
      const response = await disableUser(request("DELETE"), params(id)); expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "not_found", error: "Not found." });
    }
    expect(disable).not.toHaveBeenCalled();
  });
  test.each([null, new Date(0)])("refuses account_shared on PATCH /users even with a disabled other-org membership (%s); no write", async (disabledAt) => {
    await db.member.create({ data: { id: `${f.org.id}-shared`, organizationId: other.org.id, userId: f.learner.id, role: "user", disabledAt, createdAt: new Date() } });
    const original = await learner(); const update = spyOn(db.user, "update"); spies.push(update);
    const response = await renameUser(request("PATCH", { name: "Renamed" }), params(f.learner.id)); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "account_shared", error: "This person's account is also used by another organization. They can change their name in Settings." });
    expect(update).not.toHaveBeenCalled(); expect(await learner()).toEqual(original);
  });
  test("PATCH /users same name is 200 with no write, even when the account is shared", async () => {
    await db.member.create({ data: { id: `${f.org.id}-shared`, organizationId: other.org.id, userId: f.learner.id, role: "user", disabledAt: new Date(0), createdAt: new Date() } });
    const original = await learner(); const update = spyOn(db.user, "update"); spies.push(update);
    const response = await renameUser(request("PATCH", { name: f.learner.name }), params(f.learner.id)); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { ...f.learner, role: "member" } });
    expect(update).not.toHaveBeenCalled(); expect(await learner()).toEqual(original);
  });

  test.each(["practised pending", "used", "cancelled"])("DELETE assignment (API and dashboard) refuses a %s link and retains its sessions", async (kind) => {
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    const assignment = await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${f.learner.id}-member`, assignedByUserId: f.trainer.id, shareCode: `${f.org.id}-link`, expiresAt: new Date(0), status: kind === "practised pending" ? "pending" : kind } });
    const session = kind === "cancelled" ? null : await f.session({ assignmentId: assignment.id });
    const response = await deleteAssignment(request("DELETE"), params(assignment.id)); expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found", error: "Not found." });
    const dashboard = await dashboardDelete(request("DELETE", { assignmentId: assignment.id }), { params: Promise.resolve({ slug: f.roleplay.slug }) }); expect(dashboard.status).toBe(404);
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toEqual(assignment);
    if (session) expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
  });
  test.each(["API", "dashboard"])("DELETE assignment %s removes an unpractised pending link only", async (route) => {
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    const assignment = await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${f.learner.id}-member`, assignedByUserId: f.trainer.id, shareCode: `${f.org.id}-link`, expiresAt: new Date(0) } });
    const response = route === "API" ? await deleteAssignment(request("DELETE"), params(assignment.id)) : await dashboardDelete(request("DELETE", { assignmentId: assignment.id }), { params: Promise.resolve({ slug: f.roleplay.slug }) });
    expect(response.status).toBe(route === "API" ? 204 : 200);
    expect(await db.rolePlayAssignment.findUnique({ where: { id: assignment.id } })).toBeNull();
  });
  test("refuses too_many_keys on the 21st API key without calling the plugin or writing a key", async () => {
    await db.apikey.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ id: `${f.org.id}-key-${i}`, referenceId: f.org.id, key: `hash-${f.org.id}-${i}`, name: `Key ${i}`, createdAt: new Date(), updatedAt: new Date() })) });
    const original = await db.apikey.findMany({ where: { referenceId: f.org.id }, orderBy: { id: "asc" } });
    const create = spyOn(auth.api, "createApiKey").mockRejectedValue(new Error("Unexpected plugin key write")); spies.push(create);
    const response = await createKey(request("POST", { name: "21st key" })); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "too_many_keys", error: "An organization can have at most 20 API keys. Revoke one first." });
    expect(create).not.toHaveBeenCalled(); expect(await db.apikey.findMany({ where: { referenceId: f.org.id }, orderBy: { id: "asc" } })).toEqual(original);
  });

  // Hold the first real advisory lock until the competing save has read and requested the same lock.
  const gate = (slug: string) => {
    const lock = database.withLock; let arrivals = 0; let entered!: () => void; let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; }); const proceed = new Promise<void>((resolve) => { release = resolve; });
    spies.push(spyOn(database, "withLock").mockImplementation((keys, work, options) => {
      expect(keys).toEqual([`agent:${slug}`]); const first = ++arrivals === 1;
      if (!first) release();
      return lock(keys, async (tx) => { if (first) { entered(); await proceed; } return work(tx); }, options);
    }));
    return writing;
  };
  const recording = (skill: string) => ingestScenario(f.org.id, { kind: "ROLEPLAY", personaSlug: f.org.slug, skill, items: [], scenario: { scenario: "rp", name: "Recorded role play", description: "Explain a decision", trainer_role: "Trainer", learner_role: "Learner", steps: [{ id: "explain", name: "Explain", trainer_moves: [], learner_moves: [] }] } });
  test("copilot updateRoleplay concurrent with recordings skill save keeps both changes, script/files and one skill version bump", async () => {
    const original = await recording("# Old script"); const oldFiles = new Map(files); const writing = gate(f.roleplay.slug);
    const save = recording("# New script"); await writing;
    const [saved, settings] = await Promise.all([save, runCopilotStudio({ org: f.org, user: f.trainer }, { action: "updateRoleplay", slug: f.roleplay.slug, before: { preUpload: true }, tools: { canvas: true } })]);
    expect(saved.version).toBe(original.version + 1); expect(settings).toMatchObject({ changed: true });
    const current = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } }); expect(current.version).toBe(saved.version);
    expect(current.data).toMatchObject({ skill: "# New script", artifacts: saved.artifacts, before: { preUpload: true }, tools: { canvas: true } });
    expect(files.get(`${saved.artifacts}/SKILL.md`)).toBe("# New script"); expect(JSON.parse(files.get(`${saved.artifacts}/items.json`)!)).toEqual([]);
    expect(JSON.parse(files.get(`${saved.artifacts}/scenario.json`)!)).toEqual((current.data as Record<string, unknown>).scenario);
    for (const [key, text] of oldFiles) expect(files.get(key)).toBe(text);
    expect(await db.specVersion.count({ where: { orgId: f.org.id, entitySlug: f.roleplay.slug } })).toBe(2);
  });
  test("two concurrent recordings updateRoleplay settings preserve both patched keys without a version bump", async () => {
    const original = await recording("# Script"); const writing = gate(f.roleplay.slug);
    const first = updateRoleplay(f.org.id, f.roleplay.slug, { before: { preUpload: true }, tools: { canvas: true } }); await writing;
    await Promise.all([first, updateRoleplay(f.org.id, f.roleplay.slug, { before: { duringUpload: true }, tools: { preview: true } })]);
    const current = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } }); expect(current.version).toBe(original.version);
    expect(current.data).toMatchObject({ before: { preUpload: true, duringUpload: true }, tools: { canvas: true, preview: true } });
  });
  test("two concurrent updateTwin saves serialize with one bump each, keep settings and description, and never throw P2002", async () => {
    const writing = gate(f.twin.slug);
    const first = updateTwin(f.org.id, f.twin.slug, { description: "New description" }); await writing;
    const outcomes = await Promise.allSettled([first, updateTwin(f.org.id, f.twin.slug, { settings: { preUpload: true } })]);
    expect(outcomes).toEqual([{ status: "fulfilled", value: { version: 2, changed: true } }, { status: "fulfilled", value: { version: 3, changed: true } }]);
    expect(await twin()).toMatchObject({ version: 3, data: { objective: "New description", before: { preUpload: true } } });
    expect((await versions()).map((row) => row.version)).toEqual([1, 2]); expect((await versions())[1].data).toMatchObject({ objective: "New description" });
  });
  test("updateTwin unchanged JSONB key order returns changed:false and writes no version or agent", async () => {
    const data = { before: beforeSettings({}), objective: "Description", name: f.twin.name };
    await db.agent.update({ where: { id: f.twin.id }, data: { data } });
    const original = await twin(); const write = spyOn(db.agent, "update"); spies.push(write);
    expect(await updateTwin(f.org.id, f.twin.slug, {})).toEqual({ version: 1, changed: false });
    expect(await twin()).toEqual(original); expect(await versions()).toEqual([]); expect(write).not.toHaveBeenCalled();
  });
  test("concurrent updateTwin description save must not restore the name read before its lock", async () => {
    const writing = gate(f.twin.slug);
    const rename = updateTwin(f.org.id, f.twin.slug, { name: "Renamed twin" }); await writing;
    const results = await Promise.all([rename, updateTwin(f.org.id, f.twin.slug, { description: "New description" })]);
    expect(results.map((result) => result.version)).toEqual([2, 3]); expect((await versions()).map((row) => row.version)).toEqual([1, 2]);
    // Expected the new name and description; HEAD reads the old found.name at lib/twin/manage.ts:20, restoring "Twin".
    expect(await twin()).toMatchObject({ name: "Renamed twin", version: 3, data: { name: "Renamed twin", objective: "New description" } });
  });
});
