import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import * as org from "@/lib/org";
import * as s3 from "@/lib/s3";
import { attachPersonaVoice } from "@/lib/voices";
import { saveSpec } from "@/lib/specs";
import type { Voice } from "@/lib/generated/prisma/client";
import { GET as list, POST as upload } from "@/app/api/tts/voices/route";
import { GET as resolve, PATCH as rename, DELETE as remove } from "@/app/api/tts/voices/[voiceId]/route";
import { POST as speech } from "@/app/api/tts/speech/route";
import { GET as defaultVoice } from "@/app/api/tts/default-voice/route";
import { POST as personaMedia } from "@/app/api/personas/[slug]/media/route";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

mock.module("server-only", () => ({}));
const { pageRouter } = await import("@/lib/pages/router");

describe.skipIf(!localMinutesDb)("Phase 1 voice API eligibility and trusted TTS protocol", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  const voices: string[] = [];
  const files = new Map<string, Uint8Array | string>();
  const spies: { mockRestore(): void }[] = [];
  let environment: Record<string, string | undefined>;
  let fetching: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let writing: ReturnType<typeof spyOn<typeof s3, "putObject">>;
  let deleting: ReturnType<typeof spyOn<typeof s3, "deleteObject">>;
  let signing: ReturnType<typeof spyOn<typeof s3, "presignedGetUrl">>;
  let membership: ReturnType<typeof spyOn<typeof org, "studioOrRefusal">>;

  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture();
    await f.create(); await other.create();
    voices.length = 0; files.clear();
    environment = {
      TTS_SERVICE_URL: process.env.TTS_SERVICE_URL,
      TTS_SERVICE_KEY: process.env.TTS_SERVICE_KEY,
      TTS_APP_KEY: process.env.TTS_APP_KEY,
    };
    process.env.TTS_SERVICE_URL = "https://tts.test";
    process.env.TTS_SERVICE_KEY = "voice-api-service-key";
    process.env.TTS_APP_KEY = "voice-api-resolver-key";
    membership = spyOn(org, "studioOrRefusal").mockResolvedValue({ ...f.org, accentColor: null, role: "admin", user: f.trainer });
    fetching = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) !== "https://tts.test/v1/audio/speech") throw new Error(`Unexpected network call: ${url}`);
      return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { "Content-Type": "audio/pcm", "X-Sample-Rate": "48000" } });
    });
    writing = spyOn(s3, "putObject").mockImplementation(async (key, bytes) => { files.set(key, bytes); });
    deleting = spyOn(s3, "deleteObject").mockImplementation(async (key) => { files.delete(key); });
    signing = spyOn(s3, "presignedGetUrl").mockImplementation(async (key) => `https://s3.test/${key}`);
    spies.push(membership, fetching, writing, deleting, signing,
      spyOn(s3, "deletePrefix").mockImplementation(async () => { throw new Error("Voice deletion must not delete arbitrary prefixes"); }),
      spyOn(s3, "getObjectText").mockImplementation(async (key) => {
        const body = files.get(key);
        if (typeof body !== "string") throw new Error(`Missing transcript: ${key}`);
        return body;
      }),
    );
  });

  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const fixture of [other, f]) {
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
    await db.voice.deleteMany({ where: { OR: [{ id: { in: voices } }, { orgId: { in: [f.org.id, other.org.id] } }] } });
  });

  const fixtureVoice = async (orgId: string | null = f.org.id, extra: Partial<Pick<Voice, "name" | "kind" | "status" | "s3AudioKey">> = {}) => {
    const id = randomUUID();
    const voice = await db.voice.create({ data: {
      id, orgId, name: id, kind: orgId ? "cloned" : "sample", status: "ready",
      s3AudioKey: `${s3.voicePrefix(orgId, id)}/reference.wav`,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...extra,
    } });
    voices.push(id);
    files.set(voice.s3AudioKey, new Uint8Array([0, 0]));
    return voice;
  };
  const context = (voiceId: string) => ({ params: Promise.resolve({ voiceId }) });
  const request = (body: unknown, headers: HeadersInit = {}) => new NextRequest("https://web.test/api/tts/speech", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const speechRequest = (voice: string, extra: Record<string, unknown> = {}, headers: HeadersInit = {}) => request({ voice, input: "Please describe your approach.", ...extra }, headers);
  const resolverRequest = (key = "voice-api-resolver-key") => new NextRequest("https://web.test/api/tts/voices/id", { headers: { authorization: `Bearer ${key}` } });
  const uploadRequest = (audio: File, name?: string, transcript?: string) => {
    const form = new FormData();
    form.set("audio", audio);
    if (name !== undefined) form.set("name", name);
    if (transcript !== undefined) form.set("transcript", transcript);
    return new NextRequest("https://web.test/api/tts/voices", { method: "POST", body: form });
  };
  const mediaRequest = (fields: Record<string, string | File>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    return new Request("https://web.test/api/personas/persona/media", { method: "POST", body });
  };
  const personaContext = () => ({ params: Promise.resolve({ slug: f.org.slug }) });
  const page = () => pageRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });

  test("own-persona voice selection shares the existing ID without copying files", async () => {
    const voice = await fixtureVoice();
    const before = await db.voice.count({ where: { orgId: f.org.id } });
    const first = await personaMedia(mediaRequest({ voiceId: voice.id }), personaContext());
    expect(first.status).toBe(200);
    const selected = await db.persona.findUniqueOrThrow({ where: { orgId_slug: { orgId: f.org.id, slug: f.org.slug } } });
    expect(selected.isOwn).toBe(true);
    expect(selected.voiceId).toBe(voice.id);
    expect((await personaMedia(mediaRequest({ voiceId: voice.id }), personaContext())).status).toBe(200);
    expect((await db.persona.findUniqueOrThrow({ where: { id: selected.id } })).updatedAt).toEqual(selected.updatedAt);
    expect(await db.voice.count({ where: { orgId: f.org.id } })).toBe(before);
    expect(writing).not.toHaveBeenCalled();
    expect(deleting).not.toHaveBeenCalled();
  });

  test("own-persona media refuses foreign voices, avatar changes and ambiguous uploads before mutation", async () => {
    const original = await fixtureVoice();
    const alternate = await fixtureVoice();
    const foreign = await fixtureVoice(other.org.id);
    await attachPersonaVoice(f.org.id, f.org.slug, original.id);
    const denied = await personaMedia(mediaRequest({ voiceId: foreign.id }), personaContext());
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ code: "voice_unavailable" });
    for (const key of ["image", "video"]) {
      const response = await personaMedia(mediaRequest({
        voiceId: alternate.id,
        [key]: new File(["fixture"], key === "image" ? "avatar.png" : "avatar.webm", { type: key === "image" ? "image/png" : "video/webm" }),
      }), personaContext());
      expect(response.status).toBe(403);
    }
    const ambiguous = await personaMedia(mediaRequest({
      voiceId: alternate.id, audio: new File(["fixture"], "reference.wav", { type: "audio/wav" }),
    }), personaContext());
    expect(ambiguous.status).toBe(400);
    expect((await db.persona.findUniqueOrThrow({ where: { orgId_slug: { orgId: f.org.id, slug: f.org.slug } } })).voiceId).toBe(original.id);
    expect(writing).not.toHaveBeenCalled();
    expect(deleting).not.toHaveBeenCalled();
  });

  test("browser listing and speech accept own ready voices and global samples, never private or unusable voices", async () => {
    const own = await fixtureVoice();
    const sample = await fixtureVoice(null);
    const denied = [
      await fixtureVoice(other.org.id),
      await fixtureVoice(null, { kind: "cloned" }),
      await fixtureVoice(f.org.id, { status: "failed" }),
      await fixtureVoice(f.org.id, { status: "pending" }),
      await fixtureVoice(f.org.id, { s3AudioKey: "" }),
    ];
    const response = await list();
    expect(response.status).toBe(200);
    const library = await response.json() as { voices: { id: string }[] };
    const ids = library.voices.map((voice) => voice.id);
    expect(ids).toContain(own.id); expect(ids).toContain(sample.id);
    for (const voice of denied) {
      expect(ids).not.toContain(voice.id);
      expect((await speech(speechRequest(voice.id))).status).toBe(404);
    }
    expect(fetching).not.toHaveBeenCalled();
    for (const voice of [own, sample]) {
      const audio = await speech(speechRequest(voice.id));
      expect(audio.status).toBe(200);
      expect(audio.headers.get("content-type")).toBe("audio/pcm");
      expect(audio.headers.get("x-sample-rate")).toBe("48000");
      expect(audio.headers.has("authorization")).toBe(false);
      expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([0, 0, 1, 0]);
    }
    expect(fetching).toHaveBeenCalledTimes(2);
    expect(fetching).toHaveBeenLastCalledWith("https://tts.test/v1/audio/speech", expect.objectContaining({
      headers: { "Content-Type": "application/json", Authorization: "Bearer voice-api-service-key" },
      body: JSON.stringify({ model: "voxcpm2", voice: sample.id, input: "Please describe your approach.", stream: true, response_format: "pcm" }),
    }));
  });

  test("speech strictly bounds the request and refuses model or reference overrides before synthesis", async () => {
    const voice = await fixtureVoice();
    for (const body of [
      { voice: voice.id, input: "" },
      { voice: voice.id, input: "   " },
      { voice: voice.id, input: "x".repeat(5001) },
      { input: "Missing voice" },
      { voice: voice.id, input: "Hello", model: "another-model" },
      { voice: voice.id, input: "Hello", response_format: "mp3" },
      { voice: voice.id, input: "Hello", stream: "true" },
      { voice: voice.id, input: "Hello", ref_audio: "https://another-org.test/private.wav" },
      { voice: voice.id, input: "Hello", ref_text: "Hidden reference" },
      { voice: voice.id, input: "Hello", provider: "external" },
      { voice: voice.id, input: "Hello", orgId: other.org.id },
    ]) expect((await speech(request(body))).status).toBe(400);
    expect((await speech(new NextRequest("https://web.test/api/tts/speech", { method: "POST", body: "{" }))).status).toBe(400);
    expect(fetching).not.toHaveBeenCalled();
    const audio = await speech(speechRequest(voice.id, { model: "voxcpm2", stream: false, response_format: "wav" }));
    expect(audio.status).toBe(200);
    expect(fetching).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ model: "voxcpm2", voice: voice.id, input: "Please describe your approach.", stream: false, response_format: "wav" }),
    }));
  });

  test("trusted agent speech preserves its fixed-model service-key protocol without an organization parameter", async () => {
    const voice = await fixtureVoice(other.org.id);
    membership.mockImplementation(async () => { throw new Error("A service request must not use browser membership"); });
    const audio = await speech(speechRequest(voice.id, { model: "voxcpm2", stream: true, response_format: "pcm" }, { authorization: "Bearer voice-api-service-key" }));
    expect(audio.status).toBe(200);
    expect(fetching).toHaveBeenCalledTimes(1);
    expect(membership).not.toHaveBeenCalled();
    const failed = await fixtureVoice(other.org.id, { status: "failed" });
    expect((await speech(speechRequest(failed.id, {}, { authorization: "Bearer voice-api-service-key" }))).status).toBe(404);
    expect(fetching).toHaveBeenCalledTimes(1);
  });

  test("resolver requires its exact key, preserves updatedAt cache tokens, and rejects unusable references before signing", async () => {
    const voice = await fixtureVoice(other.org.id);
    for (const key of ["wrong", "", "voice-api-service-key"]) expect((await resolve(resolverRequest(key), context(voice.id))).status).toBe(401);
    for (const unusable of [
      await fixtureVoice(other.org.id, { status: "failed" }),
      await fixtureVoice(other.org.id, { s3AudioKey: "" }),
    ]) expect((await resolve(resolverRequest(), context(unusable.id))).status).toBe(404);
    expect(signing).not.toHaveBeenCalled();
    const response = await resolve(resolverRequest(), context(voice.id));
    expect(await response.json()).toEqual({
      id: voice.id, name: voice.name, version: voice.updatedAt.toISOString(),
      audioUrl: `https://s3.test/${voice.s3AudioKey}`, transcript: null,
    });
    expect(signing).toHaveBeenCalledWith(voice.s3AudioKey, 600);
  });

  test("invalid object ownership is refused before audio signing or synthesis", async () => {
    const voice = await fixtureVoice(f.org.id, { s3AudioKey: `${s3.orgPrefix(other.org.id)}/private.wav` });
    expect((await speech(speechRequest(voice.id))).status).toBe(409);
    expect((await resolve(resolverRequest(), context(voice.id))).status).toBe(409);
    expect(fetching).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled();
  });

  test("stored references from an older storage base still work in the library, resolver and deletion", async () => {
    const voice = await fixtureVoice();
    const prefix = `old/trainertwin/kb/${f.org.id}/tts-voices/${voice.id}`;
    const s3AudioKey = `${prefix}/reference.wav`;
    const s3TranscriptKey = `${prefix}/transcript.txt`;
    files.set(s3AudioKey, new Uint8Array([0, 0]));
    files.set(s3TranscriptKey, "  Original reference text.\n");
    await db.voice.update({ where: { id: voice.id }, data: { s3AudioKey, s3TranscriptKey } });

    expect(await (await list()).json()).toMatchObject({ voices: expect.arrayContaining([expect.objectContaining({ id: voice.id })]) });
    const reference = await resolve(resolverRequest(), context(voice.id));
    expect(reference.status).toBe(200);
    expect(await reference.json()).toMatchObject({ id: voice.id, audioUrl: `https://s3.test/${s3AudioKey}`, transcript: "Original reference text." });
    expect(signing).toHaveBeenCalledWith(s3AudioKey, 600);
    expect((await remove(resolverRequest(), context(voice.id))).status).toBe(204);
    expect(deleting.mock.calls.map(([key]) => key).sort()).toEqual([s3AudioKey, s3TranscriptKey]);
    expect(await db.voice.findUnique({ where: { id: voice.id } })).toBeNull();
  });

  test("library and picker listings exclude invalid object references", async () => {
    const valid = await fixtureVoice();
    const invalid = [
      await fixtureVoice(f.org.id, { s3AudioKey: " \t\n " }),
      await fixtureVoice(f.org.id, { s3AudioKey: `${s3.orgPrefix(f.org.id)}/knowledge/book/source.wav` }),
      await fixtureVoice(other.org.id),
      await fixtureVoice(null, { kind: "cloned" }),
    ];
    const invalidTranscript = await fixtureVoice();
    await db.voice.update({
      where: { id: invalidTranscript.id },
      data: { s3TranscriptKey: `${s3.orgPrefix(f.org.id)}/avatars/photo.jpg` },
    });
    invalid.push(invalidTranscript);
    const rest = await (await list()).json() as { voices: { id: string }[] };
    const library = await page().voices();
    const editor = await page().personaEdit({ slug: f.org.slug });
    for (const ids of [rest.voices, [...library.mine, ...library.samples], editor.voices].map((rows) => rows.map((row) => row.id))) {
      expect(ids).toContain(valid.id);
      for (const voice of invalid) expect(ids).not.toContain(voice.id);
    }
    expect(fetching).not.toHaveBeenCalled();
    expect(signing).not.toHaveBeenCalled();
    expect(writing).not.toHaveBeenCalled();
  });

  test("upload retains optional reference text, supports unnamed trainer capture, and exposes only a finished voice", async () => {
    const response = await upload(uploadRequest(new File(["RIFF reference fixture"], "voice.wav", { type: "audio/wav" }), undefined, "Read this reference passage."));
    expect(response.status).toBe(200);
    const body = await response.json() as { voice: { id: string; name: string; status: string } };
    expect(body.voice).toEqual({ id: expect.any(String), name: "Untitled voice", status: "ready" });
    const voice = await db.voice.findUniqueOrThrow({ where: { id: body.voice.id } });
    expect(voice.orgId).toBe(f.org.id);
    expect(voice.s3AudioKey.startsWith(`${s3.voicePrefix(f.org.id, voice.id)}/`)).toBe(true);
    expect(voice.s3TranscriptKey).not.toBeNull();
    expect(files.get(voice.s3TranscriptKey!)).toBe("Read this reference passage.");
    const metadata = await resolve(resolverRequest(), context(voice.id));
    expect(await metadata.json()).toMatchObject({ transcript: "Read this reference passage.", version: voice.updatedAt.toISOString() });
    expect(writing).toHaveBeenCalledTimes(2);
    const renamed = await rename(new NextRequest("https://web.test/api/tts/voices/id", { method: "PATCH", body: JSON.stringify({ name: "Saved voice" }) }), context(voice.id));
    expect(renamed.status).toBe(200);
    const changed = await db.voice.findUniqueOrThrow({ where: { id: voice.id } });
    const resolved = await resolve(resolverRequest(), context(voice.id));
    expect(await resolved.json()).toMatchObject({ name: "Saved voice", version: changed.updatedAt.toISOString() });
  });

  test("invalid and failed uploads leave no selectable voice or foreign storage write", async () => {
    const before = await db.voice.count({ where: { orgId: f.org.id } });
    for (const audio of [new File([], "empty.wav", { type: "audio/wav" }), new File(["not audio"], "file.txt", { type: "text/plain" })]) {
      expect((await upload(uploadRequest(audio, "Invalid voice"))).status).toBe(400);
    }
    expect(writing).not.toHaveBeenCalled();
    writing.mockRejectedValueOnce(new Error("Test object write failed"));
    await expect(upload(uploadRequest(new File(["RIFF fixture"], "voice.wav", { type: "audio/wav" }), "Failed voice"))).rejects.toThrow("Test object write failed");
    expect(await db.voice.count({ where: { orgId: f.org.id } })).toBe(before);
    expect(files.size).toBe(0);
  });

  test("rename and deletion guard ownership, read-only samples, and all shared persona references before touching files", async () => {
    const own = await fixtureVoice();
    const sample = await fixtureVoice(null);
    const foreign = await fixtureVoice(other.org.id);
    const patch = () => new NextRequest("https://web.test/api/tts/voices/id", { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) });
    for (const voice of [sample, foreign]) {
      expect((await rename(patch(), context(voice.id))).status).toBe(404);
      expect((await remove(patch(), context(voice.id))).status).toBe(404);
    }
    const second = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second", data: {} } });
    await attachPersonaVoice(f.org.id, f.org.slug, own.id);
    await attachPersonaVoice(f.org.id, second.slug, own.id);
    expect((await remove(patch(), context(own.id))).status).toBe(409);
    expect(deleting).not.toHaveBeenCalled();
    expect(await db.persona.count({ where: { voiceId: own.id } })).toBe(2);
    await db.persona.updateMany({ where: { orgId: f.org.id }, data: { voiceId: null } });
    expect((await remove(patch(), context(own.id))).status).toBe(204);
    expect(await db.voice.findUnique({ where: { id: own.id } })).toBeNull();
    expect(deleting).toHaveBeenCalledWith(own.s3AudioKey);
  });

  test("incomplete deletion stays visible for its owner, cannot be selected, and finishes on retry", async () => {
    const voice = await fixtureVoice();
    const foreign = await fixtureVoice(other.org.id, { status: "deleting" });
    const change = () => new NextRequest("https://web.test/api/tts/voices/id", { method: "PATCH", body: JSON.stringify({ name: "Changed" }) });
    deleting.mockRejectedValueOnce(new Error("Temporary object storage failure"));
    const failed = await remove(change(), context(voice.id));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "voice_delete_retryable" });
    expect((await db.voice.findUniqueOrThrow({ where: { id: voice.id } })).status).toBe("deleting");
    const library = await page().voices();
    expect(library.mine).toContainEqual(expect.objectContaining({ id: voice.id, status: "deleting" }));
    expect(library.mine.map((row) => row.id)).not.toContain(foreign.id);
    const rest = await (await list()).json() as { voices: { id: string }[] };
    expect(rest.voices.map((row) => row.id)).not.toContain(voice.id);
    expect((await page().personaEdit({ slug: f.org.slug })).voices.map((row) => row.id)).not.toContain(voice.id);
    expect((await speech(speechRequest(voice.id))).status).toBe(404);
    expect((await rename(change(), context(voice.id))).status).toBe(409);
    expect(fetching).not.toHaveBeenCalled();
    expect((await remove(change(), context(voice.id))).status).toBe(204);
    expect(await db.voice.findUnique({ where: { id: voice.id } })).toBeNull();
    expect((await page().voices()).mine.map((row) => row.id)).not.toContain(voice.id);
    expect(files.has(voice.s3AudioKey)).toBe(false);
  });

  test("spec voice overrides enforce the same availability boundary and can reference a shared sample", async () => {
    const sample = await fixtureVoice(null);
    const data = (voiceId: string) => `agent:\n  name: Test role play\n  voiceId: ${voiceId}\n  objective: Practise\n  opening: Hello\n  config: {}\n`;
    for (const voice of [
      await fixtureVoice(other.org.id), await fixtureVoice(null, { kind: "cloned" }),
      await fixtureVoice(f.org.id, { status: "failed" }), await fixtureVoice(f.org.id, { s3AudioKey: "" }),
    ]) await expect(saveSpec("agents", f.roleplay.slug, data(voice.id), f.org.id)).rejects.toThrow("not available");
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0);
    await saveSpec("agents", f.roleplay.slug, data(sample.id), f.org.id);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).data).toMatchObject({ voiceId: sample.id });
  });

  test("default voice is always a ready non-empty global sample", async () => {
    const sample = await fixtureVoice(null, { name: "! Voice API test sample" });
    const denied = [
      await fixtureVoice(null, { name: "! A cloned voice", kind: "cloned" }),
      await fixtureVoice(null, { name: "! A failed sample", status: "failed" }),
      await fixtureVoice(null, { name: "! An empty sample", s3AudioKey: "" }),
      await fixtureVoice(null, { name: "! A whitespace sample", s3AudioKey: " \t " }),
      await fixtureVoice(null, { name: "! A malformed sample", s3AudioKey: `${s3.orgPrefix("shared")}/knowledge/source.wav` }),
    ];
    const response = await defaultVoice();
    expect(response.status).toBe(200);
    const body = await response.json() as { voice: { id: string } };
    expect(denied.map((voice) => voice.id)).not.toContain(body.voice.id);
    const selected = await db.voice.findUniqueOrThrow({ where: { id: body.voice.id } });
    expect(selected).toMatchObject({ orgId: null, kind: "sample", status: "ready" });
    expect(selected.s3AudioKey).not.toBe("");
    expect((await speech(speechRequest(sample.id))).status).toBe(200);
  });
});
