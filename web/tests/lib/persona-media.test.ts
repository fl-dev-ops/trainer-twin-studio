import { beforeEach, expect, mock, test } from "bun:test";

// Persona = voice + avatar + prompt (data) + program settings. These helpers store the voice / avatar reference
// files in S3, link them one-to-one to the persona, and never damage the media in use when a replacement fails.

type Persona = { id: string; orgId: string | null; slug: string; name: string; voiceId: string | null; avatarId: string | null; settings: unknown };
type Voice = { id: string; s3AudioKey: string; s3TranscriptKey: string | null };
type Avatar = { id: string; s3ImageKey: string | null; s3VideoKey: string | null };
let personas: Persona[];
let voices: Map<string, Voice>;
let avatars: Map<string, Avatar>;
let objects: Map<string, unknown>;
let deleted: string[];
let failPut: RegExp | null;
let nextId = 0;

mock.module("@/lib/db", () => ({
  db: {
    persona: {
      findFirst: async ({ where, select }: { where: { orgId: string | null; slug: string }; select: Record<string, unknown> }) => {
        const p = personas.find((x) => x.orgId === where.orgId && x.slug === where.slug);
        if (!p) return null;
        if ("voice" in select) {
          return { settings: p.settings, voice: p.voiceId ? voices.get(p.voiceId) ?? null : null, avatar: p.avatarId ? avatars.get(p.avatarId) ?? null : null };
        }
        return p;
      },
      updateMany: async ({ where, data }: { where: Partial<Persona> & { id: string }; data: Partial<Persona> }) => {
        const p = personas.find((x) => x.id === where.id && Object.entries(where).every(([k, v]) => (x as Record<string, unknown>)[k] === v));
        if (!p) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Persona> }) => Object.assign(personas.find((x) => x.id === where.id)!, data),
    },
    voice: {
      create: async () => { const v = { id: `voice-${++nextId}`, s3AudioKey: "", s3TranscriptKey: null }; voices.set(v.id, v); return { ...v }; },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...voices.get(where.id)! }),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Voice> }) => Object.assign(voices.get(where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => voices.delete(where.id),
    },
    avatar: {
      create: async () => { const a = { id: `avatar-${++nextId}`, s3ImageKey: null, s3VideoKey: null }; avatars.set(a.id, a); return { ...a }; },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...avatars.get(where.id)! }),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Avatar> }) => Object.assign(avatars.get(where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => avatars.delete(where.id),
    },
  },
}));
mock.module("@/lib/s3", () => ({
  voicePrefix: (orgId: string | null, id: string) => `base/${orgId ?? "global"}/tts-voices/${id}`,
  avatarPrefix: (orgId: string | null, id: string) => `base/${orgId ?? "global"}/avatars/${id}`,
  putObject: async (key: string, body: unknown) => {
    if (failPut?.test(key)) throw new Error("S3 down");
    objects.set(key, body);
  },
  deleteObject: async (key: string) => { deleted.push(key); objects.delete(key); },
  getObjectText: async (key: string) => String(objects.get(key)),
  presignedGetUrl: async (key: string) => `https://s3.test/${key}`,
}));

const media = await import("@/lib/persona-media");
const file = (name: string, type: string, size = 4) => new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  personas = [
    { id: "p1", orgId: "org", slug: "daniel", name: "Daniel", voiceId: null, avatarId: null, settings: null },
    { id: "p2", orgId: null, slug: "preset", name: "Preset", voiceId: null, avatarId: null, settings: null },
  ];
  voices = new Map();
  avatars = new Map();
  objects = new Map();
  deleted = [];
  failPut = null;
});

test("first voice upload creates the persona's own voice with reference audio + transcript", async () => {
  const { voiceId } = await media.setPersonaVoice("org", "daniel", { audio: file("ref.wav", "audio/wav"), transcript: " Hello there " });
  expect(personas[0].voiceId).toBe(voiceId);
  const voice = voices.get(voiceId)!;
  expect(voice.s3AudioKey).toMatch(new RegExp(`^base/org/tts-voices/${voiceId}/reference-[0-9a-f-]{36}\\.wav$`));
  expect(objects.get(voice.s3TranscriptKey!)).toBe("Hello there");
});

test("replacing the voice keeps the same voice, writes new keys and removes the old files afterwards", async () => {
  const { voiceId } = await media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav"), transcript: "one" });
  const old = { ...voices.get(voiceId)! };
  await media.setPersonaVoice("org", "daniel", { audio: file("b.mp3", "audio/mpeg") });
  const now = voices.get(voiceId)!;
  expect(voices.size).toBe(1);
  expect(now.s3AudioKey.endsWith(".mp3")).toBe(true);
  expect(now.s3TranscriptKey).toBeNull(); // the transcript belongs to the old audio
  expect(deleted).toEqual([old.s3AudioKey, old.s3TranscriptKey]);
});

test("a failed replacement leaves the voice in use untouched", async () => {
  const { voiceId } = await media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav") });
  const before = { ...voices.get(voiceId)! };
  failPut = /reference/;
  await expect(media.setPersonaVoice("org", "daniel", { audio: file("b.wav", "audio/wav") })).rejects.toThrow("S3 down");
  expect(voices.get(voiceId)).toEqual(before);
  expect(objects.has(before.s3AudioKey)).toBe(true);
});

test("a failed first upload leaves no voice behind", async () => {
  failPut = /reference/;
  await expect(media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav") })).rejects.toThrow("S3 down");
  expect(voices.size).toBe(0);
  expect(personas[0].voiceId).toBeNull();
});

test("avatar holds both a reference image and a video; each can be replaced on its own", async () => {
  const { avatarId } = await media.setPersonaAvatar("org", "daniel", { image: file("me.png", "image/png"), video: file("me.mp4", "video/mp4") });
  expect(personas[0].avatarId).toBe(avatarId);
  const first = { ...avatars.get(avatarId)! };
  expect(first.s3ImageKey).toMatch(new RegExp(`^base/org/avatars/${avatarId}/image/[0-9a-f-]{36}\\.png$`));
  expect(first.s3VideoKey).toMatch(new RegExp(`^base/org/avatars/${avatarId}/video/[0-9a-f-]{36}\\.mp4$`));
  await media.setPersonaAvatar("org", "daniel", { video: file("new.webm", "video/webm") });
  expect(avatars.get(avatarId)!.s3ImageKey).toBe(first.s3ImageKey);
  expect(avatars.get(avatarId)!.s3VideoKey!.endsWith(".webm")).toBe(true);
  expect(deleted).toEqual([first.s3VideoKey]);
});

test("rejects unsupported, empty and oversized files before storing anything", async () => {
  await expect(media.setPersonaVoice("org", "daniel", { audio: file("a.txt", "text/plain") })).rejects.toThrow(/Unsupported audio/);
  await expect(media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav", 0) })).rejects.toThrow(/empty/);
  await expect(media.setPersonaAvatar("org", "daniel", { image: file("a.gif", "image/gif") })).rejects.toThrow(/Unsupported image/);
  const big = file("big.mp4", "video/mp4");
  Object.defineProperty(big, "size", { value: 100 * 1024 * 1024 + 1 });
  await expect(media.setPersonaAvatar("org", "daniel", { video: big })).rejects.toThrow(/100 MB/);
  await expect(media.setPersonaAvatar("org", "daniel", {})).rejects.toThrow(/image or a video/);
  expect(objects.size).toBe(0);
  expect(voices.size + avatars.size).toBe(0);
});

test("another org's persona slug is not found (org-scoped lookup)", async () => {
  await expect(media.setPersonaVoice("other-org", "daniel", { audio: file("a.wav", "audio/wav") })).rejects.toThrow(/not found/);
});

test("global presets store media under global/", async () => {
  const { avatarId } = await media.setPersonaAvatar(null, "preset", { image: file("p.jpg", "image/jpeg") });
  expect(avatars.get(avatarId)!.s3ImageKey).toMatch(/^base\/global\/avatars\//);
});

test("program settings are validated and stored; reading returns links, transcript and defaults", async () => {
  await expect(media.setPersonaSettings("org", "daniel", { pace: "warp" })).rejects.toThrow();
  await expect(media.setPersonaSettings("org", "daniel", { pace: "fast", extra: 1 })).rejects.toThrow();
  expect(await media.setPersonaSettings("org", "daniel", { pace: "fast" })).toEqual({ pace: "fast" });
  expect(personas[0].settings).toEqual({ pace: "fast" });

  expect(await media.getPersonaMedia("org", "daniel")).toEqual({ voice: null, avatar: null, settings: { pace: "fast" } });
  await media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav"), transcript: "Hi" });
  await media.setPersonaAvatar("org", "daniel", { image: file("a.jpg", "image/jpeg") });
  const read = await media.getPersonaMedia("org", "daniel");
  expect(read.voice).toMatchObject({ audioUrl: expect.stringMatching(/^https:\/\/s3\.test\/base\/org\/tts-voices\//), transcript: "Hi" });
  expect(read.avatar).toMatchObject({ imageUrl: expect.stringMatching(/avatars/), videoUrl: null });
  expect((await media.getPersonaMedia(null, "preset")).settings).toEqual({ pace: "normal" });
});
