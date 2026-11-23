import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as livekit from "@/lib/livekit";
import * as end from "@/lib/session-end";
import * as schedule from "@/lib/schedule-org-credits";
import * as s3 from "@/lib/s3";
import * as practice from "@/lib/practice";
import { activateSession, resolveVoiceForSession } from "@/lib/interview-sessions";
import { connectVoice, startSessionNow, type OpenedSession } from "@/lib/session-activation";
import { ensureDeployment } from "@/lib/deployments";
import { attachPersonaVoice, deleteVoice } from "@/lib/voices";
import { fundOrg } from "../setup/meteroid";
import { getAgentConfigForAgent } from "@/lib/specs";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import type { Prisma, Voice } from "@/lib/generated/prisma/client";


describe.skipIf(!localMinutesDb)("Phase 1 native session voice pins (real Postgres)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let previousSecret: string | undefined;
  const voices: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  let connecting: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;
  let deleting: ReturnType<typeof spyOn<typeof s3, "deleteObject">>;
  let fetching: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture();
    await f.create(); await other.create(); voices.length = 0;
    await fundOrg({ orgId: f.org.id, minutes: 1000 });
    previousSecret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "voice-session-test-secret";
    const fetch = globalThis.fetch;
    fetching = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "meteroid.test") return fetch(url, init);
      if (parsed.pathname !== "/internal/sessions") throw new Error(`Unexpected network call: ${url}`);
      return new Response(null, { status: 204 });
    });
    connecting = spyOn(livekit, "activateLiveKitSession").mockResolvedValue({
      token: "participant-token", room: "local-test-room", dispatchId: "local-test-dispatch", videoEgressId: null, videoS3Key: null,
    });
    deleting = spyOn(s3, "deleteObject").mockResolvedValue(undefined);
    spies.push(fetching, connecting, deleting,
      spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined),
      spyOn(end, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(schedule, "scheduleOrgUsage").mockResolvedValue(undefined),
    );
  });

  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (previousSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = previousSecret;
    for (const fixture of [other, f]) {
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
    await db.voice.deleteMany({ where: { id: { in: voices } } });
  });

  const fixtureVoice = async (orgId: string | null = f.org.id, extra: Partial<Pick<Voice, "kind" | "status" | "s3AudioKey">> = {}) => {
    const id = randomUUID();
    const voice = await db.voice.create({ data: {
      id, orgId, name: id, kind: orgId ? "cloned" : "sample", status: "ready",
      s3AudioKey: `${s3.voicePrefix(orgId, id)}/reference.wav`, ...extra,
    } });
    voices.push(id);
    return voice;
  };
  const input = (idempotencyKey = randomUUID()) => ({ orgId: f.org.id, userId: f.trainer.id, agentSlug: f.roleplay.slug, mode: "voice" as const, idempotencyKey });
  const start = async (value = input()) => {
    const session = await activateSession(value);
    if (!session) throw new Error("Expected a session");
    return session;
  };
  const openedLegacy = (id: string): OpenedSession => ({
    id, agentSlug: f.roleplay.slug, status: "active", mode: "voice",
    runtimeToken: "browser-token", agentToken: "runtime-token", secondsLeft: null, calibrationId: null,
  });

  test("session creation pins the resolved voice; reconnects survive persona and agent voice switches", async () => {
    const original = await fixtureVoice();
    const replacement = await fixtureVoice();
    const override = await fixtureVoice();
    await attachPersonaVoice(f.org.id, f.org.slug, original.id);
    const value = input();
    const session = await start(value);
    const initial = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(initial.resolvedVoiceId).toBe(original.id);
    await connectVoice(value, session);
    await attachPersonaVoice(f.org.id, f.org.slug, replacement.id);
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { voiceId: override.id } } });
    const resumed = await start(value);
    expect(resumed).toMatchObject({ id: session.id, resumed: true });
    await connectVoice(value, resumed);
    for (const [dispatch] of connecting.mock.calls) expect(dispatch.voice).toBe(original.id);
    const unchanged = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(unchanged.resolvedVoiceId).toBe(original.id);
    expect(unchanged.compiledSnapshot).toEqual(initial.compiledSnapshot);
    await expect(deleteVoice(f.org.id, original.id)).rejects.toMatchObject({ code: "voice_in_use", status: 409 });
    expect(deleting).not.toHaveBeenCalled();
    await expect(Promise.resolve(db.interviewSession.update({ where: { id: session.id }, data: { resolvedVoiceId: replacement.id } }))).rejects.toThrow("A session voice cannot change once resolved");
    const later = await start();
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: later.id } })).resolvedVoiceId).toBe(override.id);
  });

  test("chat creation needs no voice and does not resolve or pin a default", async () => {
    const lookup = spyOn(db.voice, "findFirst").mockImplementation(async () => { throw new Error("Chat must not require a voice"); });
    spies.push(lookup);
    const session = await activateSession({ ...input(), mode: "chat" });
    if (!session) throw new Error("Expected a chat session");
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).resolvedVoiceId).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(connecting).not.toHaveBeenCalled();
  });

  test.each(["missing", "failed", "empty"] as const)("chat preserves a %s historical voice reference without granting voice access", async (state) => {
    const voice = state === "missing" ? null : await fixtureVoice(f.org.id, state === "failed" ? { status: "failed" } : { s3AudioKey: "" });
    const voiceId = voice?.id ?? randomUUID();
    const data = { name: "Historical role play", voiceId, original: { preserved: true } };
    await db.specVersion.create({ data: {
      orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version: 1, data,
    } });
    await db.agent.update({ where: { id: f.roleplay.id }, data: { version: 2 } });
    const compiled = await getAgentConfigForAgent(f.roleplay.id, f.org.id, undefined, [], db, {
      agentVersion: 1, personaSlug: f.org.slug, personaVersion: 1,
    });
    if (!compiled) throw new Error("Expected the historical compiled configuration");
    expect(compiled.agent.data).toEqual(data);
    const row = await f.session({
      userId: f.trainer.id, mode: "chat", status: "active", endedAt: null,
      resolvedVoiceId: null, compiledSnapshot: compiled as Prisma.InputJsonValue,
    });
    const saved = await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved.resolvedVoiceId).toBeNull();
    expect(saved.compiledSnapshot).toEqual(compiled);
    await expect(connectVoice(input(), openedLegacy(row.id))).rejects.toMatchObject({ code: "session_mode_mismatch" });
    await expect(db.$transaction((tx) => resolveVoiceForSession(f.org.id, voiceId, tx))).rejects.toMatchObject({ code: "voice_unavailable" });
    await expect(Promise.resolve(f.session({ mode: "voice", compiledSnapshot: compiled as Prisma.InputJsonValue }))).rejects.toThrow("Voice reference must be an available");
    if (voice) await expect(deleteVoice(f.org.id, voice.id)).rejects.toMatchObject({ code: "voice_in_use" });
    expect(connecting).not.toHaveBeenCalled();
    expect(fetching).not.toHaveBeenCalled();
    expect(deleting).not.toHaveBeenCalled();
  });

  test("chat snapshots cannot acquire a reference while voice deletion is in flight", async () => {
    const voice = await fixtureVoice(f.org.id, { status: "deleting" });
    await expect(Promise.resolve(f.session({
      mode: "chat", compiledSnapshot: { agent: { data: { voiceId: voice.id } } },
    }))).rejects.toThrow("A deleting voice cannot acquire historical references");
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test.each(["chat", "voice"] as const)("resuming %s as the other mode refuses before token, allowance, pin or LiveKit changes", async (mode) => {
    const voice = await fixtureVoice();
    await attachPersonaVoice(f.org.id, f.org.slug, voice.id);
    const value = { ...input(), mode };
    const started = await startSessionNow(value);
    if (!started.ok) throw new Error(started.error);
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: started.session.id } });
    const ledger = await db.minuteLedger.findMany({ where: { orgId: f.org.id } });
    connecting.mockClear(); fetching.mockClear();
    const allowance = spyOn(practice, "startAllowance");
    spies.push(allowance);
    expect(await startSessionNow({ ...value, mode: mode === "chat" ? "voice" : "chat" })).toMatchObject({
      ok: false, status: 409, code: "session_mode_mismatch",
    });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id } })).toEqual(ledger);
    expect(allowance).not.toHaveBeenCalled();
    expect(connecting).not.toHaveBeenCalled();
    expect(fetching).not.toHaveBeenCalled();
  });

  test.each(["chat", "voice"] as const)("same-mode %s resume keeps its original allowance and voice pin", async (mode) => {
    const voice = await fixtureVoice();
    await attachPersonaVoice(f.org.id, f.org.slug, voice.id);
    const value = { ...input(), mode };
    const first = await activateSession(value);
    if (!first) throw new Error("Expected a session");
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: first.id } });
    const allowance = spyOn(practice, "startAllowance");
    spies.push(allowance);
    fetching.mockClear();
    const resumed = await activateSession(value);
    expect(resumed).toMatchObject({ id: first.id, mode, resumed: true });
    const after = await db.interviewSession.findUniqueOrThrow({ where: { id: first.id } });
    expect(after).toEqual(before);
    expect(allowance).not.toHaveBeenCalled();
    expect(fetching).not.toHaveBeenCalled();
  });

  test("a different studio member cannot resume or rotate another user's idempotent session", async () => {
    const value = input();
    const first = await activateSession({ ...value, mode: "chat" });
    if (!first) throw new Error("Expected a chat session");
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: first.id } });
    const teammate = await db.user.create({ data: {
      id: `${f.org.id}-teammate`, name: "Teammate", email: `${f.org.id}-teammate@example.com`, emailVerified: true,
    } });
    await db.member.create({ data: {
      id: `${teammate.id}-member`, organizationId: f.org.id, userId: teammate.id, role: "team", createdAt: new Date(),
    } });
    expect(await startSessionNow({ ...value, userId: teammate.id, mode: "chat" })).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: first.id } })).toEqual(before);
    expect(connecting).not.toHaveBeenCalled();
  });

  test("a foreign organization in an activation-key row never receives its session tokens", async () => {
    const deployment = await ensureDeployment(other.org.id, other.roleplay.id);
    const key = randomUUID();
    const row = await f.session({
      userId: f.trainer.id, mode: "chat", status: "active", endedAt: null,
      activationKey: `deployment:${deployment.id}:${key}`, runtimeTokenHash: randomUUID(),
    });
    expect(await startSessionNow({
      orgId: other.org.id, userId: other.trainer.id, agentSlug: other.roleplay.slug, mode: "chat", idempotencyKey: key,
    })).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(connecting).not.toHaveBeenCalled();
  });

  test("direct voice connection cannot upgrade an unmetered chat row", async () => {
    const value = { ...input(), mode: "chat" as const };
    const session = await activateSession(value);
    if (!session) throw new Error("Expected a chat session");
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    for (const mode of ["chat", "voice"] as const) {
      await expect(connectVoice({ ...value, mode }, session)).rejects.toMatchObject({ code: "session_mode_mismatch", status: 409 });
    }
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before);
    expect(before).toMatchObject({ resolvedVoiceId: null, allowedSeconds: null, chargesOrg: false });
    expect(connecting).not.toHaveBeenCalled();
  });

  test("session resolution rejects wrong-org, failed, empty, and non-sample global voices without a replacement", async () => {
    const denied = [
      await fixtureVoice(other.org.id),
      await fixtureVoice(f.org.id, { status: "failed" }),
      await fixtureVoice(f.org.id, { status: "pending" }),
      await fixtureVoice(f.org.id, { s3AudioKey: "" }),
      await fixtureVoice(null, { kind: "cloned" }),
    ];
    for (const voice of denied) {
      await expect(db.$transaction((tx) => resolveVoiceForSession(f.org.id, voice.id, tx))).rejects.toMatchObject({ code: "voice_unavailable", status: 400 });
    }
    const sample = await fixtureVoice(null);
    expect(await db.$transaction((tx) => resolveVoiceForSession(f.org.id, sample.id, tx))).toBe(sample.id);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(fetching).not.toHaveBeenCalled();
    expect(connecting).not.toHaveBeenCalled();
  });

  test("a legacy snapshot's recorded voice is pinned once and remains stable across multiple reconnects", async () => {
    const recorded = await fixtureVoice();
    const current = await fixtureVoice();
    await attachPersonaVoice(f.org.id, f.org.slug, current.id);
    const snapshot = { agent: { data: { voiceId: recorded.id } }, persona: { slug: f.org.slug, data: {} } };
    const row = await f.session({
      userId: f.trainer.id, status: "active", endedAt: null, mode: "voice", resolvedVoiceId: null, compiledSnapshot: snapshot,
    });
    const session = openedLegacy(row.id);
    await connectVoice(input(), session);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).resolvedVoiceId).toBe(recorded.id);
    await db.persona.update({ where: { orgId_slug: { orgId: f.org.id, slug: f.org.slug } }, data: { voiceId: null } });
    await connectVoice(input(), { ...session, resumed: true });
    await connectVoice(input(), { ...session, resumed: true });
    for (const [dispatch] of connecting.mock.calls) expect(dispatch.voice).toBe(recorded.id);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).compiledSnapshot).toEqual(snapshot);
  });

  test("legacy rows without a recorded voice pin today's compatibility resolution, not a claimed historical voice", async () => {
    const current = await fixtureVoice();
    const changed = await fixtureVoice();
    await attachPersonaVoice(f.org.id, f.org.slug, current.id);
    const row = await f.session({ userId: f.trainer.id, status: "active", endedAt: null, mode: "voice", resolvedVoiceId: null });
    const session = openedLegacy(row.id);
    await Promise.all([connectVoice(input(), session), connectVoice(input(), { ...session, resumed: true })]);
    await attachPersonaVoice(f.org.id, f.org.slug, changed.id);
    await connectVoice(input(), { ...session, resumed: true });
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).resolvedVoiceId).toBe(current.id);
    for (const [dispatch] of connecting.mock.calls) expect(dispatch.voice).toBe(current.id);
  });

  test("connection requires the session's organization and user before dispatch or writes", async () => {
    const voice = await fixtureVoice();
    const row = await f.session({ status: "active", endedAt: null, resolvedVoiceId: voice.id });
    const session = openedLegacy(row.id);
    for (const wrong of [
      { ...input(), orgId: other.org.id },
      { ...input(), userId: other.trainer.id },
    ]) await expect(connectVoice(wrong, session)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(connecting).not.toHaveBeenCalled();
  });

  test("row-locked pin insertion and deletion cannot leave a dangling session reference", async () => {
    const voice = await fixtureVoice();
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const insertion = db.$transaction(async (tx) => {
      const resolvedVoiceId = await resolveVoiceForSession(f.org.id, voice.id, tx);
      acquired();
      await proceed;
      return tx.interviewSession.create({ data: {
        orgId: f.org.id, userId: f.learner.id, agentId: f.roleplay.id, shareCode: randomUUID(),
        personaSlug: f.org.slug, personaVersion: 1, agentSlug: f.roleplay.slug, agentVersion: 1,
        resolvedVoiceId, status: "active",
      } });
    });
    await locked;
    const deletion = deleteVoice(f.org.id, voice.id);
    release();
    const [created, removed] = await Promise.allSettled([insertion, deletion]);
    expect(created.status).toBe("fulfilled");
    expect(removed.status).toBe("rejected");
    if (removed.status !== "rejected") throw new Error("Expected in-use deletion refusal");
    expect(removed.reason).toMatchObject({ code: "voice_in_use", status: 409 });
    expect(await db.interviewSession.count({ where: { resolvedVoiceId: voice.id } })).toBe(1);
    expect(await db.voice.findUnique({ where: { id: voice.id } })).not.toBeNull();
    expect(deleting).not.toHaveBeenCalled();
  });
});
