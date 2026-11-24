import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextHeaders from "next/headers";
import * as sessionUser from "@/lib/session-user";
import { setAgentPersonas } from "@/lib/agent-personas";
import { ensureDeployment } from "@/lib/deployments";
import { activateSession, finalizeInterviewSession } from "@/lib/interview-sessions";
import { grantMinutes } from "@/lib/minutes";
import { loadSharedSession } from "@/lib/pages/learner";
import { sessionPersonaView } from "@/lib/persona-media";
import { voicePrefix } from "@/lib/s3";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

/**
 * A role play with several personas (specs/agents.md): each call is played by one active persona picked at random, in
 * that persona's name and voice; the learner sees only the situation before the call.
 */
describe.skipIf(!localMinutesDb)("role play persona pool, learner side (local database)", () => {
  let f: MinutesFixture;
  let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let headers: ReturnType<typeof spyOn<typeof nextHeaders, "headers">>;
  let identity: ReturnType<typeof spyOn<typeof sessionUser, "resolveSessionUser">>;
  let secret: string | undefined;
  let main: { id: string; slug: string };
  const code = () => `${f.org.id}-roleplay`;

  /** An org persona with its own ready voice. */
  async function persona(name: string) {
    const slug = `${f.org.slug}-${name.toLowerCase()}`;
    const voiceId = `${slug}-voice`;
    await db.voice.create({ data: { id: voiceId, orgId: f.org.id, name, kind: "cloned", status: "ready", s3AudioKey: `${voicePrefix(f.org.id, voiceId)}/reference.wav` } });
    return db.persona.create({ data: { orgId: f.org.id, slug, name, data: { name }, voiceId }, select: { id: true, slug: true, voiceId: true } });
  }

  beforeEach(async () => {
    f = minutesFixture();
    await f.create({ voice: true });
    main = await db.persona.findFirstOrThrow({ where: { orgId: f.org.id, slug: f.org.slug }, select: { id: true, slug: true } });
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${f.learner.id}-member`, shareCode: code(), assignedByUserId: f.trainer.id, expiresAt: new Date(Date.now() + 3600_000) } });
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "pool-test-secret";
    const networkFetch = globalThis.fetch;
    fetchMock = spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).includes("meteroid.test") ? networkFetch(url, init) : Promise.resolve(new Response(null, { status: 204 })));
    headers = spyOn(nextHeaders, "headers").mockResolvedValue(new Headers({ host: `${f.org.slug}.example.com` }));
    identity = spyOn(sessionUser, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/sign-in" });
    await fundOrg({ orgId: f.org.id, minutes: 600, note: "test" });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 360 });
  });
  afterEach(async () => {
    fetchMock?.mockRestore(); headers?.mockRestore(); identity?.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.rolePlayAssignment.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.deleteMany({ where: { orgId: f.org.id } });
    await db.persona.deleteMany({ where: { orgId: f.org.id } });
    await db.voice.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  /** The learner starts the call from their link, and it ends (a link resumes a live call instead of starting anew). */
  async function call() {
    const started = await activateSession({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: code(), mode: "voice" });
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: started.id }, select: { personaSlug: true, resolvedVoiceId: true, compiledSnapshot: true } });
    const screen = await sessionPersonaView(f.org.id, started.id);
    await finalizeInterviewSession({ sessionId: started.id, requestedStatus: "completed" });
    return { ...row, snapshot: (row.compiledSnapshot as { persona?: { slug?: string } }).persona?.slug, screen };
  }

  test("each call plays one active persona at random, in its own name and voice; a switched-off one never plays", async () => {
    const daniel = await persona("Daniel");
    const sara = await persona("Sara");
    const off = await persona("Off");
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [
      { personaId: daniel.id, active: true }, { personaId: sara.id, active: true }, { personaId: off.id, active: false },
    ], tx));
    const voiceOf = new Map([[daniel.slug, daniel.voiceId], [sara.slug, sara.voiceId]]);

    const played = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const c = await call();
      played.add(c.personaSlug);
      expect([daniel.slug, sara.slug]).toContain(c.personaSlug);
      expect(c.snapshot).toBe(c.personaSlug);
      expect(c.resolvedVoiceId).toBe(voiceOf.get(c.personaSlug)!);
      expect(c.screen).toEqual({ slug: c.personaSlug, name: c.personaSlug === daniel.slug ? "Daniel" : "Sara", photoUrl: null });
    }
    // 24 fair draws from two: both come up (a miss is about one in eight million).
    expect([...played].sort()).toEqual([daniel.slug, sara.slug].sort());
  });

  test("a studio member trying it can choose who answers; a learner's link always picks at random", async () => {
    const daniel = await persona("Daniel");
    const sara = await persona("Sara");
    const off = await persona("Off");
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [
      { personaId: daniel.id, active: true }, { personaId: sara.id, active: true }, { personaId: off.id, active: false },
    ], tx));
    const tryIt = async (choice?: string) => {
      const started = await activateSession({ orgId: f.org.id, userId: f.trainer.id, userEmail: f.trainer.email, agentSlug: f.roleplay.slug, mode: "voice", persona: choice });
      const row = await db.interviewSession.findUniqueOrThrow({ where: { id: started.id }, select: { personaSlug: true, resolvedVoiceId: true } });
      await finalizeInterviewSession({ sessionId: started.id, requestedStatus: "completed" });
      return row;
    };
    for (let i = 0; i < 5; i++) expect(await tryIt(sara.slug)).toEqual({ personaSlug: sara.slug, resolvedVoiceId: sara.voiceId });
    // Only an active persona of this role play.
    await expect(tryIt(off.slug)).rejects.toMatchObject({ status: 400 });
    await expect(tryIt("someone-else")).rejects.toMatchObject({ status: 400 });
    // A learner's link can't choose.
    await expect(activateSession({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: code(), mode: "voice", persona: sara.slug }))
      .rejects.toMatchObject({ status: 400 });
  });

  test("one active persona: every call is the role play's own persona", async () => {
    const extra = await persona("Extra");
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [{ personaId: main.id, active: true }, { personaId: extra.id, active: false }], tx));
    for (let i = 0; i < 5; i++) expect((await call()).personaSlug).toBe(main.slug);
  });

  test("a live call that resumes keeps the persona it started with", async () => {
    const daniel = await persona("Daniel");
    const sara = await persona("Sara");
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [{ personaId: daniel.id, active: true }, { personaId: sara.id, active: true }], tx));
    const start = () => activateSession({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: code(), mode: "voice" });
    const first = await start();
    const picked = (await db.interviewSession.findUniqueOrThrow({ where: { id: first.id } })).personaSlug;
    for (let i = 0; i < 5; i++) {
      const again = await start();
      expect(again).toMatchObject({ id: first.id, resumed: true });
      expect((await sessionPersonaView(f.org.id, again.id))?.slug).toBe(picked);
    }
  });

  test("with several personas, the role play's own voice never overrides the picked persona's; it covers one without a voice", async () => {
    const daniel = await persona("Daniel");
    const sara = await persona("Sara");
    const mute = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-mute`, name: "Mute", data: {} }, select: { id: true, slug: true } });
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [
      { personaId: daniel.id, active: true }, { personaId: sara.id, active: true }, { personaId: mute.id, active: true },
    ], tx));
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { voiceId: sara.voiceId } } });
    const expected = new Map([[daniel.slug, daniel.voiceId], [sara.slug, sara.voiceId], [mute.slug, sara.voiceId]]);
    const played = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const c = await call();
      expect(c.resolvedVoiceId).toBe(expected.get(c.personaSlug)!);
      played.add(c.personaSlug);
    }
    expect(played.has(daniel.slug) && played.has(mute.slug)).toBe(true);
  });

  test("before the call the learner sees only the situation: no name, photo or intro video of who will answer", async () => {
    const daniel = await persona("Daniel");
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [{ personaId: main.id, active: true }, { personaId: daniel.id, active: true }], tx));
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { introVideo: "https://example.com/intro.mp4", learnerBrief: "A lead filled in the form after your ad. Call them back." } } });
    const view = await loadSharedSession(code());
    if (view.kind !== "session") throw new Error(`expected the call screen, got ${view.kind}`);
    expect(view.props.agentPersonaNames).toBeUndefined();
    expect(view.props.agentPhotos?.[f.roleplay.slug] ?? null).toBeNull();
    expect(view.props.introVideos?.[f.roleplay.slug] ?? null).toBeNull();
  });
});
