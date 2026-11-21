import { beforeEach, expect, mock, test } from "bun:test";

type Persona = { id: string; orgId: string | null; slug: string; name: string; voiceId: string | null; avatarId: string | null; settings: unknown };
type Voice = { id: string; orgId: string | null; name: string; kind: string; status: string; s3AudioKey: string; s3TranscriptKey: string | null };
type VoiceWhere = { id?: string; orgId?: string | null; status?: string; s3AudioKey?: { not: string }; OR?: { orgId: string | null; kind?: string }[] };
type Avatar = { id: string; s3ImageKey: string | null; s3VideoKey: string | null };
let personas: Persona[];
let voices: Map<string, Voice>;
let avatars: Map<string, Avatar>;
let objects: Map<string, unknown>;
let deleted: string[];
let failPut: RegExp | null;
let failDelete: RegExp | null;
let failReady: boolean;
let failAfterReady: boolean;
let failFinalize: boolean;
let beforePut: (() => void) | null;
let beforeDelete: ((key: string) => Promise<void>) | null;
let reads: string[];
let puts: string[];
let personaWrites: number;
let nextId = 0;

function matchesVoice(voice: Voice, where: VoiceWhere) {
  return (!where.id || voice.id === where.id)
    && (!("orgId" in where) || voice.orgId === where.orgId)
    && (!where.status || voice.status === where.status)
    && (!where.s3AudioKey || voice.s3AudioKey !== where.s3AudioKey.not)
    && (!where.OR || where.OR.some((scope) => voice.orgId === scope.orgId && (!scope.kind || voice.kind === scope.kind)));
}

const fakeDb = {
    $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => query.join("").includes("voice_is_referenced")
      ? [{ used: personas.some((persona) => persona.voiceId === values[0]) }] : [],
    persona: {
      findFirst: async ({ where, select }: { where: { orgId: string | null; slug: string }; select: Record<string, unknown> }) => {
        const p = personas.find((x) => x.orgId === where.orgId && x.slug === where.slug);
        if (!p) return null;
        if ("avatar" in select) {
          return { settings: p.settings, voiceId: p.voiceId, avatar: p.avatarId ? avatars.get(p.avatarId) ?? null : null };
        }
        return p;
      },
      updateMany: async ({ where, data }: { where: Partial<Persona> & { id: string }; data: Partial<Persona> }) => {
        const p = personas.find((x) => x.id === where.id && Object.entries(where).every(([k, v]) => (x as Record<string, unknown>)[k] === v));
        if (!p) return { count: 0 };
        personaWrites++;
        Object.assign(p, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Persona> }) => Object.assign(personas.find((x) => x.id === where.id)!, data),
    },
    voice: {
      create: async ({ data }: { data: Omit<Voice, "id" | "s3TranscriptKey"> }) => { const v = { ...data, id: `voice-${++nextId}`, s3TranscriptKey: null }; voices.set(v.id, v); return { ...v }; },
      findFirst: async ({ where }: { where: VoiceWhere }) => [...voices.values()].find((voice) => matchesVoice(voice, where)) ?? null,
      findMany: async ({ where }: { where: VoiceWhere }) => [...voices.values()].filter((voice) => matchesVoice(voice, where)),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...voices.get(where.id)! }),
      update: async ({ where, data }: { where: VoiceWhere & { id: string }; data: Partial<Voice> }) => {
        const current = voices.get(where.id);
        if (!current || !matchesVoice(current, where)) throw Object.assign(new Error("Voice not found"), { code: "P2025" });
        if (data.status === "ready" && failReady) throw new Error("Database update failed");
        const voice = Object.assign(current, data);
        if (data.status === "ready" && failAfterReady) throw new Error("Ready response lost");
        return voice;
      },
      delete: async ({ where }: { where: { id: string; status?: string } }) => {
        if (where.status && voices.get(where.id)?.status !== where.status) throw new Error("Pending voice not found");
        return voices.delete(where.id);
      },
      deleteMany: async ({ where }: { where: VoiceWhere }) => {
        if (failFinalize) throw new Error("Voice row deletion failed");
        const matching = [...voices.values()].filter((voice) => matchesVoice(voice, where));
        for (const voice of matching) voices.delete(voice.id);
        return { count: matching.length };
      },
    },
    avatar: {
      create: async () => { const a = { id: `avatar-${++nextId}`, s3ImageKey: null, s3VideoKey: null }; avatars.set(a.id, a); return { ...a }; },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...avatars.get(where.id)! }),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Avatar> }) => Object.assign(avatars.get(where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => avatars.delete(where.id),
    },
};
mock.module("@/lib/db", () => ({
  db: { ...fakeDb, $transaction: async (work: (tx: typeof fakeDb) => Promise<unknown>) => work(fakeDb) },
}));
const realS3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...realS3,
  orgPrefix: (orgId: string) => `base/${orgId}`,
  voicePrefix: (orgId: string | null, id: string) => `base/${orgId ?? "global"}/tts-voices/${id}`,
  avatarPrefix: (orgId: string | null, id: string) => `base/${orgId ?? "global"}/avatars/${id}`,
  putObject: async (key: string, body: unknown) => {
    beforePut?.();
    puts.push(key);
    if (failPut?.test(key)) throw new Error("S3 down");
    objects.set(key, body);
  },
  deleteObject: async (key: string) => {
    deleted.push(key);
    await beforeDelete?.(key);
    if (failDelete?.test(key)) throw new Error("S3 cleanup failed");
    objects.delete(key);
  },
  getObjectBytes: async (key: string) => { reads.push(key); throw new Error("Attachment must not read audio"); },
  getObjectText: async (key: string) => {
    reads.push(key);
    if (!objects.has(key)) throw new Error("Missing transcript");
    return String(objects.get(key));
  },
  presignedGetUrl: async (key: string) => `https://s3.test/${key}`,
}));

const media = await import("@/lib/persona-media");
const voiceService = await import("@/lib/voices");
const file = (name: string, type: string, size = 4) => new File([new Uint8Array(size)], name, { type });
function libraryVoice(id: string, patch: Partial<Voice> = {}) {
  const voice: Voice = {
    id, orgId: "org", name: id, kind: "cloned", status: "ready",
    s3AudioKey: `base/org/tts-voices/${id}/reference.wav`, s3TranscriptKey: null, ...patch,
  };
  voices.set(id, voice);
  objects.set(voice.s3AudioKey, new Uint8Array([1, 2, 3]));
  return voice;
}

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
  failDelete = null;
  failReady = false;
  failAfterReady = false;
  failFinalize = false;
  beforePut = null;
  beforeDelete = null;
  reads = [];
  puts = [];
  personaWrites = 0;
});

test("upload becomes ready only after its reference audio and transcript persist", async () => {
  beforePut = () => expect([...voices.values()].every((voice) =>
    voice.status === "pending" && voice.s3AudioKey.startsWith(`base/org/tts-voices/${voice.id}/reference-`) && voice.s3TranscriptKey,
  )).toBe(true);
  const { voiceId } = await media.setPersonaVoice("org", "daniel", { audio: file("ref.wav", "audio/wav"), transcript: " Hello there " });
  expect(personas[0].voiceId).toBe(voiceId);
  const voice = voices.get(voiceId)!;
  expect(voice.s3AudioKey).toMatch(new RegExp(`^base/org/tts-voices/${voiceId}/reference-[0-9a-f-]{36}\\.wav$`));
  expect(objects.get(voice.s3TranscriptKey!)).toBe("Hello there");
  expect(voice.status).toBe("ready");
});

test("replacing a shared recording creates another voice and preserves the old voice and files", async () => {
  const { voiceId } = await media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav"), transcript: "one" });
  const old = { ...voices.get(voiceId)! };
  personas.push({ ...personas[0], id: "p3", slug: "other" });
  const replacement = await media.setPersonaVoice("org", "daniel", { audio: file("b.mp3", "audio/mpeg") });
  const now = voices.get(replacement.voiceId)!;
  expect(replacement.voiceId).not.toBe(voiceId);
  expect(voices.size).toBe(2);
  expect(now.s3AudioKey.endsWith(".mp3")).toBe(true);
  expect(now.s3TranscriptKey).toBeNull();
  expect(voices.get(voiceId)).toEqual(old);
  expect(personas[2].voiceId).toBe(voiceId);
  expect(objects.has(old.s3AudioKey)).toBe(true);
  expect(objects.has(old.s3TranscriptKey!)).toBe(true);
  expect(deleted).toEqual([]);
});

test("a failed replacement leaves the voice in use untouched", async () => {
  const { voiceId } = await media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav") });
  const before = { ...voices.get(voiceId)! };
  failPut = /reference/;
  await expect(media.setPersonaVoice("org", "daniel", { audio: file("b.wav", "audio/wav") })).rejects.toThrow("S3 down");
  expect(voices.get(voiceId)).toEqual(before);
  expect(voices.size).toBe(1);
  expect(personas[0].voiceId).toBe(voiceId);
  expect(objects.has(before.s3AudioKey)).toBe(true);
});

test("a failed first upload leaves no voice behind", async () => {
  failPut = /reference/;
  await expect(media.setPersonaVoice("org", "daniel", { audio: file("a.wav", "audio/wav") })).rejects.toThrow("S3 down");
  expect(voices.size).toBe(0);
  expect(personas[0].voiceId).toBeNull();
});

test("a failed transcript or ready update removes only this upload's new files and row", async () => {
  const existing = libraryVoice("existing");
  failPut = /transcript/;
  await expect(voiceService.createVoice("org", { name: "New", audio: file("a.wav", "audio/wav"), transcript: "hello" })).rejects.toThrow("S3 down");
  expect([...voices.keys()]).toEqual([existing.id]);
  expect([...objects.keys()]).toEqual([existing.s3AudioKey]);
  failPut = null;
  failReady = true;
  await expect(voiceService.createVoice("org", { name: "New", audio: file("a.wav", "audio/wav") })).rejects.toThrow("Database update failed");
  expect([...voices.keys()]).toEqual([existing.id]);
  expect([...objects.keys()]).toEqual([existing.s3AudioKey]);
});

test("upload cleanup failures surface together with the upload failure", async () => {
  failPut = /transcript/;
  failDelete = /reference/;
  await expect(voiceService.createVoice("org", { name: "New", audio: file("a.wav", "audio/wav"), transcript: "hello" })).rejects.toMatchObject({
    code: "voice_delete_retryable", status: 503,
    cause: { errors: [expect.objectContaining({ message: "S3 down" }), expect.objectContaining({ message: "S3 cleanup failed" })] },
  });
  expect(voices.size).toBe(1);
  const [retiring] = [...voices.values()];
  expect(retiring.status).toBe("deleting");
  expect(objects.has(retiring.s3AudioKey)).toBe(true);
  expect(await voiceService.listAvailableVoices("org")).toEqual([]);
  failDelete = null;
  await voiceService.deleteVoice("org", retiring.id);
  expect(voices.size).toBe(0);
  expect(objects.size).toBe(0);
});

test("an ambiguous ready response never cleans files that may already be selected", async () => {
  failAfterReady = true;
  await expect(voiceService.createVoice("org", { name: "New", audio: file("a.wav", "audio/wav"), transcript: "hello" })).rejects.toThrow(AggregateError);
  const [voice] = [...voices.values()];
  expect(voice.status).toBe("ready");
  expect(objects.has(voice.s3AudioKey)).toBe(true);
  expect(objects.has(voice.s3TranscriptKey!)).toBe(true);
  expect(deleted).toEqual([]);
});

test("library attachment shares its ID without storage reads, writes, copies or renames; reselection is idempotent", async () => {
  const voice = libraryVoice("shared", { name: "Original" });
  const original = { ...voice };
  personas.push({ ...personas[0], id: "p3", slug: "other" });
  expect(await media.setPersonaVoiceFrom("org", "daniel", voice.id)).toEqual({ voiceId: voice.id, name: "Original" });
  await media.setPersonaVoiceFrom("org", "other", voice.id);
  const writesBefore = personaWrites;
  await media.setPersonaVoiceFrom("org", "daniel", voice.id);
  expect(personaWrites).toBe(writesBefore);
  expect([personas[0].voiceId, personas[2].voiceId]).toEqual([voice.id, voice.id]);
  expect(voices.size).toBe(1);
  expect(voice).toEqual(original);
  expect(reads).toEqual([]);
  expect(puts).toEqual([]);
  expect(deleted).toEqual([]);
});

test("switching a persona leaves another persona's voice and original recording untouched", async () => {
  const first = libraryVoice("first");
  const second = libraryVoice("second");
  personas.push({ ...personas[0], id: "p3", slug: "other" });
  await media.setPersonaVoiceFrom("org", "daniel", first.id);
  await media.setPersonaVoiceFrom("org", "other", first.id);
  await media.setPersonaVoiceFrom("org", "daniel", second.id);
  expect(personas[0].voiceId).toBe(second.id);
  expect(personas[2].voiceId).toBe(first.id);
  expect(voices.size).toBe(2);
  expect(objects.size).toBe(2);
  expect(deleted).toEqual([]);
});

test("eligibility includes used organization voices and explicit global samples, never other orgs or global clones", async () => {
  libraryVoice("own");
  libraryVoice("sample", { orgId: null, kind: "sample", s3AudioKey: "base/shared/tts-voices/sample/reference.wav" });
  libraryVoice("clone", { orgId: null, s3AudioKey: "base/global/tts-voices/clone/reference.wav" });
  libraryVoice("foreign", { orgId: "other", s3AudioKey: "base/other/tts-voices/foreign/reference.wav" });
  libraryVoice("pending", { status: "pending" });
  libraryVoice("failed", { status: "failed" });
  libraryVoice("deleting", { status: "deleting" });
  libraryVoice("empty", { s3AudioKey: "" });
  await media.setPersonaVoiceFrom("org", "daniel", "own");
  expect((await media.pickableVoices("org")).map((voice: { id: string }) => voice.id).sort()).toEqual(["own", "sample"]);
  await media.setPersonaVoiceFrom("org", "daniel", "sample");
  for (const id of ["clone", "foreign", "pending", "failed", "deleting", "empty", "missing"]) {
    await expect(media.setPersonaVoiceFrom("org", "daniel", id)).rejects.toMatchObject({ code: "voice_unavailable", status: 404 });
  }
  await voiceService.attachPersonaVoice(null, "preset", "clone");
  expect(personas[1].voiceId).toBe("clone");
});

test("unsafe audio and transcript keys fail before signing, downloading or attaching", async () => {
  libraryVoice("unsafe-audio", { s3AudioKey: "base/other/tts-voices/private.wav" });
  libraryVoice("unsafe-transcript", { s3TranscriptKey: "base/org/../other/private.txt" });
  for (const id of ["unsafe-audio", "unsafe-transcript"]) {
    await expect(media.setPersonaVoiceFrom("org", "daniel", id)).rejects.toMatchObject({ code: "voice_asset_invalid" });
  }
  expect(personas[0].voiceId).toBeNull();
  expect(reads).toEqual([]);
  expect(puts).toEqual([]);
});

test("same-org knowledge, avatar and other voice files cannot be attached or deleted through a voice", async () => {
  libraryVoice("knowledge", { s3AudioKey: "base/org/knowledge/book/source.wav" });
  libraryVoice("avatar", { s3AudioKey: "base/org/avatars/avatar-id/image/photo.wav" });
  libraryVoice("another-voice", { s3AudioKey: "base/org/tts-voices/different-id/reference.wav" });
  libraryVoice("transcript", { s3TranscriptKey: "base/org/knowledge/book/source.txt" });
  for (const id of ["knowledge", "avatar", "another-voice", "transcript"]) {
    await expect(voiceService.findAvailableVoice("org", id)).rejects.toMatchObject({ code: "voice_asset_invalid" });
    await expect(media.setPersonaVoiceFrom("org", "daniel", id)).rejects.toMatchObject({ code: "voice_asset_invalid" });
    await expect(voiceService.deleteVoice("org", id)).rejects.toMatchObject({ code: "voice_asset_invalid" });
    expect(voices.get(id)!.status).toBe("ready");
  }
  expect(personas[0].voiceId).toBeNull();
  expect(voices.size).toBe(4);
  expect(reads).toEqual([]);
  expect(deleted).toEqual([]);
});

test("listing filters malformed reference keys without storage calls or swallowed provider errors", async () => {
  libraryVoice("valid");
  libraryVoice("sample", { orgId: null, kind: "sample", s3AudioKey: "base/shared/tts-voices/sample/reference.wav" });
  libraryVoice("whitespace", { s3AudioKey: " \n\t " });
  libraryVoice("folder", { s3AudioKey: "base/org/tts-voices/folder/   " });
  libraryVoice("knowledge", { s3AudioKey: "base/org/knowledge/book/source.wav" });
  libraryVoice("transcript", { s3TranscriptKey: "base/org/knowledge/book/source.txt" });
  libraryVoice("deleting", { status: "deleting" });
  libraryVoice("global-clone", { orgId: null, s3AudioKey: "base/global/tts-voices/global-clone/reference.wav" });
  expect((await voiceService.listAvailableVoices("org")).map((voice) => voice.id).sort()).toEqual(["sample", "valid"]);
  expect((await media.pickableVoices("org")).map((voice) => voice.id).sort()).toEqual(["sample", "valid"]);
  expect(reads).toEqual([]);
  expect(puts).toEqual([]);
  expect(deleted).toEqual([]);
});

test("standalone creation does not attach a persona and keeps audio MIME/extension and the 25 MB limit", async () => {
  const voice = await voiceService.createVoice("org", { name: "  Library voice  ", audio: file("a.webm", "audio/webm") });
  expect(voice.name).toBe("Library voice");
  expect(voice.s3AudioKey).toEndWith(".webm");
  expect(personas.every((persona) => persona.voiceId === null)).toBe(true);
  const oversized = file("large.wav", "audio/wav");
  Object.defineProperty(oversized, "size", { value: 25 * 1024 * 1024 + 1 });
  await expect(voiceService.createVoice("org", { name: "Large", audio: oversized })).rejects.toThrow("25 MB");
  await expect(voiceService.createVoice("org", { name: "Long", audio: file("a.wav", "audio/wav"), transcript: "x".repeat(5001) })).rejects.toThrow("5000");
  expect(voices.size).toBe(1);
});

test("in-use deletion does not remove the row or files; unused deletion and renaming remain available", async () => {
  const voice = libraryVoice("used");
  await media.setPersonaVoiceFrom("org", "daniel", voice.id);
  await expect(voiceService.deleteVoice("org", voice.id)).rejects.toMatchObject({ code: "voice_in_use", status: 409 });
  expect(deleted).toEqual([]);
  expect(objects.has(voice.s3AudioKey)).toBe(true);
  await voiceService.renameVoice("org", voice.id, "Renamed");
  expect(voice.name).toBe("Renamed");
  personas[0].voiceId = null;
  await voiceService.deleteVoice("org", voice.id);
  expect(voices.has(voice.id)).toBe(false);
  expect(deleted).toEqual([voice.s3AudioKey]);
});

test("partial storage deletion keeps a nonselectable deleting row and can be retried", async () => {
  const voice = libraryVoice("retry", { s3TranscriptKey: "base/org/tts-voices/retry/transcript.txt" });
  objects.set(voice.s3TranscriptKey!, "Original transcript");
  beforeDelete = async () => { expect(voices.get(voice.id)!.status).toBe("deleting"); };
  failDelete = /transcript/;
  await expect(voiceService.deleteVoice("org", voice.id)).rejects.toMatchObject({
    code: "voice_delete_retryable", status: 503, cause: expect.any(AggregateError),
  });
  expect(voices.get(voice.id)).toEqual({ ...voice, status: "deleting" });
  expect(objects.has(voice.s3AudioKey)).toBe(false);
  expect(objects.has(voice.s3TranscriptKey!)).toBe(true);
  expect(await media.pickableVoices("org")).toEqual([]);
  await expect(media.setPersonaVoiceFrom("org", "daniel", voice.id)).rejects.toMatchObject({ code: "voice_unavailable" });
  await expect(voiceService.renameVoice("org", voice.id, "Changed")).rejects.toMatchObject({ code: "voice_deleting" });
  failDelete = null;
  await voiceService.deleteVoice("org", voice.id);
  expect(voices.has(voice.id)).toBe(false);
  expect(objects.size).toBe(0);
  expect(deleted.filter((key) => key === voice.s3AudioKey)).toHaveLength(2);
});

test("database finalization failure retains the deleting row for an idempotent retry", async () => {
  const voice = libraryVoice("finalize");
  failFinalize = true;
  await expect(voiceService.deleteVoice("org", voice.id)).rejects.toMatchObject({
    code: "voice_delete_retryable", status: 503, cause: { message: "Voice row deletion failed" },
  });
  expect(voices.get(voice.id)!.status).toBe("deleting");
  expect(objects.has(voice.s3AudioKey)).toBe(false);
  failFinalize = false;
  await voiceService.deleteVoice("org", voice.id);
  expect(voices.has(voice.id)).toBe(false);
});

test("concurrent deletion only removes the same voice's immutable keys and finishes idempotently", async () => {
  const voice = libraryVoice("concurrent");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bothEntered = new Promise<void>((resolve) => { entered = resolve; });
  let requests = 0;
  beforeDelete = async () => {
    if (++requests === 2) entered();
    await gate;
  };
  const deleting = Promise.all([voiceService.deleteVoice("org", voice.id), voiceService.deleteVoice("org", voice.id)]);
  await bothEntered;
  expect(voices.get(voice.id)!.status).toBe("deleting");
  release();
  await deleting;
  expect(voices.has(voice.id)).toBe(false);
  expect(objects.size).toBe(0);
  expect(deleted).toEqual([voice.s3AudioKey, voice.s3AudioKey]);
});

test("organization callers cannot rename or delete global samples or another organization's voices", async () => {
  libraryVoice("sample", { orgId: null, kind: "sample", s3AudioKey: "base/shared/tts-voices/sample/reference.wav" });
  libraryVoice("foreign", { orgId: "other" });
  for (const id of ["sample", "foreign"]) {
    await expect(voiceService.renameVoice("org", id, "Changed")).rejects.toMatchObject({ status: 404 });
    await expect(voiceService.deleteVoice("org", id)).rejects.toMatchObject({ status: 404 });
  }
  expect(voices.get("sample")!.name).toBe("sample");
  expect(deleted).toEqual([]);
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
