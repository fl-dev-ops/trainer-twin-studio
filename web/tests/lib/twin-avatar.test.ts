import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
const persona = { id: "p1", slug: "olga", name: "Olga", version: 3, data: { tone: "warm" }, isOwn: true };
let voices: Row[] = [];
let twins: Row[] = [];
const writes: { op: string; args: Row }[] = [];
const puts: string[] = [];

mock.module("@/lib/db", () => ({
  db: {
    agent: {
      findFirst: async () => ({ persona }),
      findMany: async () => twins,
      update: (args: Row) => (writes.push({ op: "agent.update", args }), args),
    },
    persona: {
      findFirst: async () => persona,
      update: (args: Row) => (writes.push({ op: "persona.update", args }), args),
    },
    voice: { findFirst: async ({ where }: { where: Row }) => voices.find((v) => v.id === where.id && v.orgId === where.orgId) ?? null },
    specVersion: { create: (args: Row) => (writes.push({ op: "specVersion.create", args }), args) },
    $transaction: async (ops: unknown[]) => ops,
  },
}));
const realS3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...realS3,
  putObject: async (key: string) => void puts.push(key),
  presignedPutUrl: async (key: string) => `https://s3.example/${key}`,
}));

const { AvatarError, avatarVideoUpload, decodePhoto, saveAvatar } = await import("@/lib/twin/avatar");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

beforeEach(() => {
  voices = [{ id: "v1", orgId: "o1", status: "ready" }, { id: "v-other", orgId: "o2", status: "ready" }];
  twins = [
    { id: "a1", slug: "acme-olga-twin", version: 5, data: { source: "twin", voiceId: "old" } },
    { id: "a2", slug: "acme-off-plan", version: 2, data: { source: "scenario-ingest" } },
  ];
  writes.length = 0;
  puts.length = 0;
});

test("photo must be a JPEG under the size limit", () => {
  expect(decodePhoto(`data:image/jpeg;base64,${jpeg}`)).toBeInstanceOf(Uint8Array);
  expect(() => decodePhoto(Buffer.from("PNG...").toString("base64"))).toThrow(AvatarError);
  expect(() => decodePhoto("")).toThrow(AvatarError);
});

test("the video upload key lives under the persona's avatar folder", async () => {
  const { key, url } = await avatarVideoUpload("o1", "video/webm");
  expect(key).toMatch(/\/personas\/p1\/sources\/avatar\/reference-\d+\.webm$/);
  expect(url).toContain(key);
});

test("save rejects a video key outside the persona's folder and another org's voice", async () => {
  const { key } = await avatarVideoUpload("o1", "video/mp4");
  await expect(saveAvatar("o1", { photo: jpeg, videoKey: "elsewhere/reference-1.webm", voiceId: "v1", transcript: "" })).rejects.toThrow("Unknown video");
  await expect(saveAvatar("o1", { photo: jpeg, videoKey: key, voiceId: "v-other", transcript: "" })).rejects.toThrow("Unknown voice");
  expect(writes).toHaveLength(0);
  expect(puts).toHaveLength(0);
});

test("save stores the photo, sets the avatar on the persona and the voice on every twin, versioned", async () => {
  const { key } = await avatarVideoUpload("o1", "video/webm");
  const result = await saveAvatar("o1", { photo: jpeg, videoKey: key, voiceId: "v1", transcript: "Cooking at home" });
  expect(result.twins).toBe(2);
  expect(result.avatarUrl).toMatch(/^\/api\/personas\/olga\/avatar\?v=\d+$/);
  expect(puts[0]).toMatch(/\/avatar\/photo-\d+\.jpg$/);

  const personaUpdate = writes.find((w) => w.op === "persona.update")!.args as { data: { version: number; data: Row } };
  expect(personaUpdate.data.version).toBe(4);
  expect(personaUpdate.data.data.tone).toBe("warm");
  expect(personaUpdate.data.data.avatarUrl).toBe(result.avatarUrl);
  expect(personaUpdate.data.data.avatar).toMatchObject({ imageKey: puts[0], videoKey: key, voiceId: "v1", transcript: "Cooking at home" });

  const agentUpdates = writes.filter((w) => w.op === "agent.update").map((w) => w.args as { data: { version: number; data: Row } });
  expect(agentUpdates.map((u) => u.data.data.voiceId)).toEqual(["v1", "v1"]);
  expect(agentUpdates.map((u) => u.data.version)).toEqual([6, 3]);
  expect(agentUpdates[0].data.data.source).toBe("twin");
  expect(writes.filter((w) => w.op === "specVersion.create")).toHaveLength(3);
});
