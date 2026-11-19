import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as ending from "@/lib/session-end";
import { MainCollectionService } from "@/lib/main-collection";
import { activateSession } from "@/lib/interview-sessions";
import { buildSessionContext } from "@/lib/session-context";
import { loadSessionSkills } from "@/lib/session-skills";
import { interviewSkillPackage } from "@/lib/interview-skill";
import { db, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const isolatedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp";
const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...s3, s3Configured: true,
  putObject: async (key: string, body: string) => { files.set(key, body); },
  getObjectText: async (key: string) => {
    const bytes = files.get(key);
    if (bytes === undefined) throw new Error(`Missing test object ${key}`);
    return bytes;
  },
}));
const { publishInterviewSkill } = await import("@/lib/scenario-ingest");

/** An interviewer-shaped no-skill role play (synthetic content, inventoried structure). */
const interviewData = (instruction = "Challenge every quantified claim.") => ({
  name: "Impact Check", objective: "Validate quantified claims.", instruction, principles: ["One question at a time."],
  opening: "Let's start with one number.",
  config: {
    context: { mode: "resume_topics_only", required: true, label: "Résumé", prompt: "Upload your résumé." },
    interview: { type: "resume", main_questions: 4, follow_ups_per_main_question: 2 }, turns: { maximum: 12 },
  },
  stages: [{ id: "impact-validation", name: "Impact Validation", objective: "Validate claims.", config: { evidence: { keys: ["baseline"], completion_keys: ["baseline"] } } }],
});

describe.skipIf(process.env.DATABASE_URL !== isolatedDatabase)("interview → skill port (real Postgres)", () => {
  let f: MinutesFixture;
  let secret: string | undefined;
  const spies: { mockRestore(): void }[] = [];

  beforeEach(async () => {
    f = minutesFixture();
    await f.create({ voice: true });
    files.clear();
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "interview-port-test";
    const fetch = globalThis.fetch;
    spies.push(
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_o, _s, _c, _v, items) => items.length),
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_o, _i, _c, items) => items.length),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
      spyOn(ending, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("meteroid.test")) return fetch(url, init);
        if (new URL(String(url)).pathname !== "/internal/sessions") throw new Error(`Unexpected network call ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    await db.agent.update({ where: { id: f.roleplay.id }, data: { version: 5, data: interviewData() } });
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id } });
    await db.skillVersionSource.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  const port = async () => {
    const original = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    const pkg = interviewSkillPackage(original);
    const published = await publishInterviewSkill(f.org.id, { personaSlug: f.org.slug, ...pkg });
    return { pkg, published };
  };

  test("publishes a new authored role play next to the untouched original; rerun is a no-op; an edit makes v2", async () => {
    const before = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    const { pkg, published } = await port();
    expect(published).toMatchObject({ slug: `${f.org.slug}-${f.roleplay.slug}`, created: true });
    const ported = await db.agent.findUniqueOrThrow({ where: { slug: published.slug }, include: { primarySkill: { include: { currentVersion: true } } } });
    expect(ported).toMatchObject({ kind: "ROLEPLAY", personaId: before.personaId });
    expect(ported.primarySkill?.currentVersion).toMatchObject({ version: 1, format: "authored-roleplay", status: "ready", indexStatus: "ready", itemCount: 0, skillText: pkg.skill });
    expect(ported.data).toMatchObject({
      source: "scenario-ingest", skill: pkg.skill, portedFrom: { slug: f.roleplay.slug, version: 5 },
      before: { preUpload: true, uploadTitle: "Résumé" }, tools: { preview: true, codeEditor: false },
    });
    expect(files.get(`${ported.primarySkill!.currentVersion!.artifacts}/SKILL.md`)).toBe(pkg.skill);
    expect(await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).toEqual(before);

    const again = await port();
    expect(again.published).toMatchObject({ slug: published.slug, created: false, version: published.version });
    expect(await db.skillVersion.count({ where: { skillId: ported.primarySkillId! } })).toBe(1);

    await db.agent.update({ where: { id: f.roleplay.id }, data: { version: 6, data: interviewData("Challenge every claim twice.") } });
    await port();
    const current = await db.skill.findUniqueOrThrow({ where: { id: ported.primarySkillId! }, include: { currentVersion: true } });
    expect(current.currentVersion?.version).toBe(2);
    expect(current.currentVersion?.skillText).toContain("Challenge every claim twice.");
  });

  test("a session on the port pins the package and the chat runs it as an interviewer skill; the original stays a no-skill interview", async () => {
    const { pkg, published } = await port();
    const start = async (agentSlug: string) => {
      const session = await activateSession({ orgId: f.org.id, userId: f.trainer.id, agentSlug, mode: "chat", idempotencyKey: crypto.randomUUID() });
      if (!session) throw new Error("Expected a session");
      return session;
    };
    const skillSession = await start(published.slug);
    const pinned = await loadSessionSkills(f.org.id, skillSession.id);
    expect(pinned?.kind).toBe("ROLEPLAY");
    const context = await buildSessionContext({ orgId: f.org.id, sessionId: skillSession.id });
    const data = context.agent?.data as Record<string, unknown>;
    expect(data.skill).toBe(pkg.skill);
    expect(data.scenario).toMatchObject({ trainer_role: "Interviewer", learner_role: "Candidate" });
    expect(data.source).toBe("scenario-ingest");

    const legacySession = await start(f.roleplay.slug);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: legacySession.id } })).skillPinsVersion).toBeNull();
    const legacy = await buildSessionContext({ orgId: f.org.id, sessionId: legacySession.id });
    expect((legacy.agent?.data as Record<string, unknown>).skill).toBeUndefined();
  });
});
