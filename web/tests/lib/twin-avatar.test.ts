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
let beforeAgentLock: (() => void) | null = null;

const personaView = () => ({
  ...persona,
  avatar: persona.avatarId ? { ...avatars.get(persona.avatarId)! } : null,
  voice: persona.voiceId ? { name: "Olga voice" } : null,
});

const fakeDb = {
    $queryRaw: async () => [],
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
        if ("voiceId" in where && where.voiceId !== persona.voiceId) return { count: 0 };
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
      findFirst: async ({ where }: { where: { id: string; OR: { orgId: string | null; kind?: string }[] } }) =>
        voices.find((voice) => voice.id === where.id && voice.status === "ready" && voice.s3AudioKey !== ""
          && where.OR.some((scope) => voice.orgId === scope.orgId && (!scope.kind || voice.kind === scope.kind))) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => { voices = voices.filter((v) => v.id !== where.id); return { count: 1 }; },
    },
    specVersion: { create: (args: Row) => (writes.push({ op: "specVersion.create", args }), args) },
    $transaction: async (ops: unknown[]) => ops,
};
mock.module("@/lib/db", () => ({
  withLock: async (keys: string[], work: (tx: typeof fakeDb) => Promise<unknown>) => {
    expect(keys).toEqual(["skill-ownership:o1", ...twins.map((twin) => `agent:${twin.slug}`).sort()]);
    beforeAgentLock?.();
    return work(fakeDb);
  },
  isUniqueViolation: (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
  db: fakeDb,
}));
const realS3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...realS3,
  putObject: async (key: string) => void puts.push(key),
  presignedPutUrl: async (key: string) => `https://s3.example/${key}`,
  presignedGetUrl: async (key: string) => `https://s3.example/get/${key}`,
  getObjectBytes: async (key: string) => {
    if (!puts.includes(key)) throw new Error("NoSuchKey");
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  },
  deleteObject: async (key: string) => void deleted.push(key),
  deletePrefix: async (prefix: string) => void deleted.push(prefix),
}));

let headshotFails = false;
const styles: number[] = [];
mock.module("@/lib/headshot", () => ({
  HEADSHOT_STYLES: ["a", "b", "c", "d"],
  professionalHeadshot: async (_photo: Uint8Array, _mime: string, style: number) => {
    styles.push(style);
    if (headshotFails) throw new Error("image model down");
    return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", ext: "png" };
  },
}));

const { AvatarError, avatarImageKey, avatarState, avatarVideoUpload, decodePhoto, makeHeadshot, saveAvatar, savePersonaVoice, selectOwnPersonaVoice } = await import("@/lib/twin/avatar");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
const voiceRow = (id: string, orgId: string | null = "o1", patch: Row = {}) => ({
  id, orgId, name: id, kind: "cloned", status: "ready",
  s3AudioKey: `${realS3.voicePrefix(orgId, id)}/reference.wav`, s3TranscriptKey: null, ...patch,
});

beforeEach(() => {
  beforeAgentLock = null;
  persona = { id: "p1", slug: "olga", name: "Olga", isOwn: true, voiceId: null, avatarId: null };
  avatars = new Map();
  voices = [
    voiceRow("v1"),
    voiceRow("v-other", "o2"),
    voiceRow("v-taken", "o1", { ownedBy: "p-someone-else" }),
    voiceRow("v-failed", "o1", { status: "failed" }),
    voiceRow("v-empty", "o1", { s3AudioKey: "" }),
    voiceRow("v-global", null),
    voiceRow("v-sample", null, { kind: "sample" }),
  ];
  twins = [
    { id: "a1", slug: "acme-olga-twin", version: 5, data: { source: "twin", voiceId: "old" } },
    { id: "a2", slug: "acme-off-plan", version: 2, data: { source: "scenario-ingest" } },
  ];
  agentVoiceRefs = [];
  writes = [];
  puts = [];
  deleted = [];
  headshotFails = false;
  styles.length = 0;
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

test("AI versions are stored as candidates of the persona's avatar, one look each", async () => {
  const first = await makeHeadshot("o1", { photo: jpeg, style: 2 });
  expect(styles).toEqual([2]);
  expect(first.key).toMatch(new RegExp(`/avatars/${persona.avatarId}/image/candidates/[0-9a-f-]{36}\\.png$`));
  expect(first.url).toContain(first.key);
  headshotFails = true;
  await expect(makeHeadshot("o1", { photo: jpeg, style: 0 })).rejects.toThrow(AvatarError);
});

test("avatar save stores the chosen AI version (photo kept as original) and clears the candidates; voice untouched", async () => {
  const candidate = await makeHeadshot("o1", { photo: jpeg, style: 0 });
  const result = await saveAvatar("o1", { photo: jpeg, headshotKey: candidate.key });
  const avatar = avatars.get(persona.avatarId!)!;
  const [original, shown] = puts.slice(1);
  expect(original).toMatch(new RegExp(`/avatars/${persona.avatarId}/image/original-[0-9a-f-]{36}\\.jpg$`));
  expect(shown).toMatch(new RegExp(`/avatars/${persona.avatarId}/image/[0-9a-f-]{36}\\.png$`));
  expect(avatar).toMatchObject({ s3ImageKey: shown, s3OriginalImageKey: original });
  expect(result.professional).toBe(true);
  expect(result.avatarUrl).toMatch(/^\/api\/personas\/olga\/avatar\?v=\d+$/);
  expect(deleted).toContain(candidate.key.slice(0, candidate.key.lastIndexOf("/") + 1));
  expect(persona.voiceId).toBeNull();
  expect(await avatarImageKey("o1", "olga")).toBe(shown);
});

test("avatar save without an avatar yet creates it; rejects an AI photo that isn't one of its candidates", async () => {
  await expect(saveAvatar("o1", { photo: jpeg, headshotKey: "orgs/o2/elsewhere.png" })).rejects.toThrow("Unknown photo");
  expect(writes.filter((w) => w.op === "avatar.update")).toHaveLength(0);
  const result = await saveAvatar("o1", { photo: jpeg, headshotKey: null });
  expect(result.professional).toBe(false);
  expect(avatars.get(persona.avatarId!)).toMatchObject({ s3ImageKey: puts[0], s3OriginalImageKey: puts[0] });
  const oldImage = puts[0];
  await saveAvatar("o1", { photo: jpeg });
  expect(deleted).toContain(oldImage);
});

test("voice save validates the video and refuses foreign, failed, empty and non-sample global voices", async () => {
  const { key } = await avatarVideoUpload("o1", "video/mp4");
  await expect(savePersonaVoice("o1", { voiceId: "v1", videoKey: "elsewhere/x.webm" })).rejects.toThrow("Unknown video");
  for (const voiceId of ["v-other", "v-failed", "v-empty", "v-global"]) {
    await expect(savePersonaVoice("o1", { voiceId, videoKey: key })).rejects.toMatchObject({ code: "voice_unavailable" });
  }
  expect(writes).toHaveLength(0);
});

test("capture accepts an eligible voice already shared with another persona without copying audio", async () => {
  const { key } = await avatarVideoUpload("o1", "video/webm");
  const before = voices.map((voice) => ({ ...voice }));
  await savePersonaVoice("o1", { voiceId: "v-taken", videoKey: key });
  expect(persona.voiceId).toBe("v-taken");
  expect(voices).toEqual(before);
  expect(puts).toEqual([]);
  expect(deleted).toEqual([]);
});

test("capture accepts a ready global sample without changing the sample", async () => {
  const { key } = await avatarVideoUpload("o1", "video/webm");
  await savePersonaVoice("o1", { voiceId: "v-sample", videoKey: key });
  expect(persona.voiceId).toBe("v-sample");
  expect(voices.find((voice) => voice.id === "v-sample")).toMatchObject({ orgId: null, kind: "sample", name: "v-sample" });
});

test("voice save sets the persona's voice, keeps the video on the avatar and clears twins' copied voice", async () => {
  const { key } = await avatarVideoUpload("o1", "video/webm");
  const result = await savePersonaVoice("o1", { voiceId: "v1", videoKey: key });
  expect(persona.voiceId).toBe("v1");
  expect(avatars.get(persona.avatarId!)).toMatchObject({ s3VideoKey: key });
  // Only the twin that carried its own voiceId is rewritten (versioned); its other data is kept.
  expect(result.twins).toBe(1);
  const update = writes.find((w) => w.op === "agent.update")!.args as { where: Row; data: { version: number; data: Row } };
  expect(update.where.id).toBe("a1");
  expect(update.data).toEqual({ version: 6, data: { source: "twin" } });
  expect(writes.filter((w) => w.op === "specVersion.create")).toHaveLength(1);
  expect(writes.some((w) => w.op === "persona.update" && "data" in (w.args.data as Row))).toBe(false); // prompt data untouched
  expect(await avatarState("o1")).toMatchObject({ hasReference: true, voiceName: "Olga voice" });
});

test("library voice selection clears copied twin overrides without creating or editing an avatar", async () => {
  const result = await selectOwnPersonaVoice("o1", "olga", "v1");
  expect(result).toEqual({ voiceId: "v1", name: "v1", twins: 1 });
  expect(persona.voiceId).toBe("v1");
  expect(persona.avatarId).toBeNull();
  expect(avatars.size).toBe(0);
  expect(writes.filter((write) => write.op === "avatar.update")).toEqual([]);
  expect(writes.filter((write) => write.op === "agent.update")).toHaveLength(1);
  expect(writes.filter((write) => write.op === "specVersion.create")).toHaveLength(1);
  expect(puts).toEqual([]);
  expect(deleted).toEqual([]);
});

test("recording again replaces the old video but preserves the previous voice and recording", async () => {
  voices.push(voiceRow("v2"));
  const first = await avatarVideoUpload("o1", "video/webm");
  await savePersonaVoice("o1", { voiceId: "v1", videoKey: first.key });
  const second = await avatarVideoUpload("o1", "video/webm");
  await savePersonaVoice("o1", { voiceId: "v2", videoKey: second.key });
  expect(persona.voiceId).toBe("v2");
  expect(deleted).toContain(first.key);
  expect(voices.find((v) => v.id === "v1")).toBeDefined();
  expect(deleted.some((key) => key.includes("/tts-voices/v1/"))).toBe(false);
});

test("voice cleanup re-reads published skill data under the agent lock", async () => {
  const { key } = await avatarVideoUpload("o1", "video/webm");
  beforeAgentLock = () => {
    twins[0] = { ...twins[0], version: 6, data: { source: "twin-creator", skill: "# Newly published", voiceId: "old" } };
  };
  await savePersonaVoice("o1", { voiceId: "v1", videoKey: key });
  const update = writes.find((write) => write.op === "agent.update")!.args;
  expect(update.data).toEqual({ version: 7, data: { source: "twin-creator", skill: "# Newly published" } });
});

test("a previous voice still named by an agent is kept", async () => {
  voices.push(voiceRow("v2"));
  const first = await avatarVideoUpload("o1", "video/webm");
  await savePersonaVoice("o1", { voiceId: "v1", videoKey: first.key });
  agentVoiceRefs = ["v1"];
  const second = await avatarVideoUpload("o1", "video/webm");
  await savePersonaVoice("o1", { voiceId: "v2", videoKey: second.key });
  expect(voices.find((v) => v.id === "v1")).toBeDefined();
});
