import { beforeEach, expect, mock, test } from "bun:test";

// Twin's brain "Voice and avatar", stored the persona way: the persona's own Avatar row holds the photo and the
// reference video; Persona.voiceId holds the cloned voice. Twins drop their copied voiceId so the persona's applies.

type Row = Record<string, unknown>;
type Avatar = { id: string; s3ImageKey: string | null; s3VideoKey: string | null; updatedAt: Date };
let persona: { id: string; slug: string; name: string; isOwn: boolean; voiceId: string | null; avatarId: string | null };
let avatars: Map<string, Avatar>;
let voices: Row[];
let twins: Row[];
let agentVoiceRefs: string[];
let writes: { op: string; args: Row }[];
let puts: string[];
let deleted: string[];
let nextId = 0;

const personaView = () => ({
  ...persona,
  avatar: persona.avatarId ? { ...avatars.get(persona.avatarId)! } : null,
  voice: persona.voiceId ? { name: "Olga voice" } : null,
});

mock.module("@/lib/db", () => ({
  db: {
    agent: {
      findFirst: async () => ({ persona: personaView() }),
      findMany: async () => twins,
      update: (args: Row) => (writes.push({ op: "agent.update", args }), args),
      count: async ({ where }: { where: { data: { equals: string } } }) => agentVoiceRefs.filter((id) => id === where.data.equals).length,
    },
    persona: {
      findFirst: async ({ where }: { where: Row }) => ("voiceId" in where ? (persona.voiceId === where.voiceId ? { id: persona.id } : null) : personaView()),
      findUniqueOrThrow: async () => ({ avatarId: persona.avatarId }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (where.avatarId === null && persona.avatarId !== null) return { count: 0 };
        Object.assign(persona, data);
        return { count: 1 };
      },
      update: (args: { data: Row }) => (writes.push({ op: "persona.update", args }), Object.assign(persona, args.data), args),
    },
    avatar: {
      create: async () => { const a = { id: `avatar-${++nextId}`, s3ImageKey: null, s3VideoKey: null, updatedAt: new Date() }; avatars.set(a.id, a); return { id: a.id }; },
      update: (args: { where: { id: string }; data: Row }) => (writes.push({ op: "avatar.update", args }), Object.assign(avatars.get(args.where.id)!, args.data), args),
      delete: async ({ where }: { where: { id: string } }) => avatars.delete(where.id),
    },
    voice: {
      findFirst: async ({ where }: { where: { id: string; orgId: string } }) => {
        const voice = voices.find((v) => v.id === where.id && v.orgId === where.orgId && v.status === "ready");
        if (!voice) return null;
        return voice.ownedBy && voice.ownedBy !== persona.id ? null : { id: voice.id };
      },
      deleteMany: async ({ where }: { where: { id: string } }) => { voices = voices.filter((v) => v.id !== where.id); return { count: 1 }; },
    },
    specVersion: { create: (args: Row) => (writes.push({ op: "specVersion.create", args }), args) },
    $transaction: async (ops: unknown[]) => ops,
  },
}));
const realS3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...realS3,
  putObject: async (key: string) => void puts.push(key),
  presignedPutUrl: async (key: string) => `https://s3.example/${key}`,
  deleteObject: async (key: string) => void deleted.push(key),
  deletePrefix: async (prefix: string) => void deleted.push(prefix),
}));

const { AvatarError, avatarImageKey, avatarState, avatarVideoUpload, decodePhoto, saveAvatar } = await import("@/lib/twin/avatar");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

beforeEach(() => {
  persona = { id: "p1", slug: "olga", name: "Olga", isOwn: true, voiceId: null, avatarId: null };
  avatars = new Map();
  voices = [
    { id: "v1", orgId: "o1", status: "ready" },
    { id: "v-other", orgId: "o2", status: "ready" },
    { id: "v-taken", orgId: "o1", status: "ready", ownedBy: "p-someone-else" },
  ];
  twins = [
    { id: "a1", slug: "acme-olga-twin", version: 5, data: { source: "twin", voiceId: "old" } },
    { id: "a2", slug: "acme-off-plan", version: 2, data: { source: "scenario-ingest" } },
  ];
  agentVoiceRefs = [];
  writes = [];
  puts = [];
  deleted = [];
});

test("photo must be a JPEG under the size limit", () => {
  expect(decodePhoto(`data:image/jpeg;base64,${jpeg}`)).toBeInstanceOf(Uint8Array);
  expect(() => decodePhoto(Buffer.from("PNG...").toString("base64"))).toThrow(AvatarError);
  expect(() => decodePhoto("")).toThrow(AvatarError);
});

test("the video upload creates the persona's own avatar once and keys under its video folder", async () => {
  const first = await avatarVideoUpload("o1", "video/webm");
  expect(persona.avatarId).toBe("avatar-" + nextId);
  expect(first.key).toMatch(new RegExp(`/avatars/${persona.avatarId}/video/[0-9a-f-]{36}\\.webm$`));
  expect(first.url).toContain(first.key);
  const again = await avatarVideoUpload("o1", "video/mp4");
  expect(avatars.size).toBe(1);
  expect(again.key).toMatch(/\.mp4$/);
});

test("save rejects a video outside the avatar's folder, another org's voice and another persona's voice", async () => {
  const { key } = await avatarVideoUpload("o1", "video/mp4");
  await expect(saveAvatar("o1", { photo: jpeg, videoKey: "elsewhere/x.webm", voiceId: "v1" })).rejects.toThrow("Unknown video");
  await expect(saveAvatar("o1", { photo: jpeg, videoKey: key, voiceId: "v-other" })).rejects.toThrow("Unknown voice");
  await expect(saveAvatar("o1", { photo: jpeg, videoKey: key, voiceId: "v-taken" })).rejects.toThrow("Unknown voice");
  expect(writes).toHaveLength(0);
  expect(puts).toHaveLength(0);
});

test("save stores photo + video on the Avatar, the voice on the persona, and clears twins' copied voice", async () => {
  const { key } = await avatarVideoUpload("o1", "video/webm");
  const result = await saveAvatar("o1", { photo: jpeg, videoKey: key, voiceId: "v1" });
  const avatar = avatars.get(persona.avatarId!)!;
  expect(puts[0]).toMatch(new RegExp(`/avatars/${persona.avatarId}/image/[0-9a-f-]{36}\\.jpg$`));
  expect(avatar).toMatchObject({ s3ImageKey: puts[0], s3VideoKey: key });
  expect(persona.voiceId).toBe("v1");
  expect(result.avatarUrl).toMatch(/^\/api\/personas\/olga\/avatar\?v=\d+$/);
  // Only the twin that carried its own voiceId is rewritten (versioned); its other data is kept.
  expect(result.twins).toBe(1);
  const update = writes.find((w) => w.op === "agent.update")!.args as { where: Row; data: { version: number; data: Row } };
  expect(update.where.id).toBe("a1");
  expect(update.data).toEqual({ version: 6, data: { source: "twin" } });
  expect(writes.filter((w) => w.op === "specVersion.create")).toHaveLength(1);
  expect(writes.some((w) => w.op === "persona.update" && "data" in (w.args.data as Row))).toBe(false); // prompt data untouched

  expect(await avatarImageKey("o1", "olga")).toBe(puts[0]);
  expect(await avatarState("o1")).toMatchObject({ photoUrl: expect.stringMatching(/\/api\/personas\/olga\/avatar\?v=/), hasReference: true, voiceName: "Olga voice" });
});

test("re-recording replaces old files and deletes the previous voice when nothing else uses it", async () => {
  voices.push({ id: "v2", orgId: "o1", status: "ready" });
  const first = await avatarVideoUpload("o1", "video/webm");
  await saveAvatar("o1", { photo: jpeg, videoKey: first.key, voiceId: "v1" });
  const oldImage = avatars.get(persona.avatarId!)!.s3ImageKey;
  const second = await avatarVideoUpload("o1", "video/webm");
  await saveAvatar("o1", { photo: jpeg, videoKey: second.key, voiceId: "v2" });
  expect(persona.voiceId).toBe("v2");
  expect(deleted).toEqual(expect.arrayContaining([oldImage, first.key]));
  expect(voices.find((v) => v.id === "v1")).toBeUndefined();
  expect(deleted.some((key) => key.includes("/tts-voices/v1/"))).toBe(true);
});

test("a previous voice still named by an agent is kept", async () => {
  voices.push({ id: "v2", orgId: "o1", status: "ready" });
  const first = await avatarVideoUpload("o1", "video/webm");
  await saveAvatar("o1", { photo: jpeg, videoKey: first.key, voiceId: "v1" });
  agentVoiceRefs = ["v1"];
  const second = await avatarVideoUpload("o1", "video/webm");
  await saveAvatar("o1", { photo: jpeg, videoKey: second.key, voiceId: "v2" });
  expect(voices.find((v) => v.id === "v1")).toBeDefined();
});
