import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as database from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { MinutesFixture } from "./minutes-test-db";

let voiceFault: { orgId: string; operation: "retirement" | "finalization" | "ready-response" } | null = null;
let faultHits = 0;
const db = database.db.$extends({
  query: {
    voice: {
      async update({ args, query }) {
        if (voiceFault?.operation === "retirement" && args.where.orgId === voiceFault.orgId && args.data.status === "deleting") {
          voiceFault = null;
          faultHits++;
          throw new Error("Retirement state failed");
        }
        const updated = await query(args);
        if (voiceFault?.operation === "ready-response" && args.where.orgId === voiceFault.orgId && args.data.status === "ready") {
          voiceFault = null;
          faultHits++;
          throw new Error("Ready response lost");
        }
        return updated;
      },
      async deleteMany({ args, query }) {
        if (voiceFault?.operation === "finalization" && args.where?.orgId === voiceFault.orgId && args.where.status === "deleting") {
          voiceFault = null;
          faultHits++;
          throw new Error("Retirement finalization failed");
        }
        return query(args);
      },
    },
  },
});
mock.module("@/lib/db", () => ({ ...database, db }));
const objects = new Map<string, Uint8Array | string>();
const deleted: string[] = [];
const reads: string[] = [];
let failPut: RegExp | null = null;
let failDelete: RegExp | null = null;
let beforePut: (() => Promise<void>) | null = null;
let beforeDelete: ((key: string) => Promise<void>) | null = null;
const s3 = await import("@/lib/s3");
const putObject = mock(async (key: string, body: Uint8Array | string) => {
  await beforePut?.();
  if (failPut?.test(key)) throw new Error("Reference storage failed");
  objects.set(key, body);
});
mock.module("@/lib/s3", () => ({
  ...s3,
  putObject,
  deleteObject: async (key: string) => {
    deleted.push(key);
    await beforeDelete?.(key);
    if (failDelete?.test(key)) throw new Error("Reference deletion failed");
    objects.delete(key);
  },
  getObjectBytes: async (key: string) => { reads.push(key); throw new Error("Attachment must not copy audio"); },
  getObjectText: async (key: string) => { reads.push(key); return objects.get(key); },
}));
const fixtures = await import("./minutes-test-db");
const { localMinutesDb, minutesFixture } = fixtures;
const { attachPersonaVoice, availableVoiceWhere, createVoice, deleteVoice, listAvailableVoices, renameVoice } = await import("@/lib/voices");

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
      ) AS waiting`;
    if (row.waiting) return;
  }
  throw new Error(`No concurrent transaction blocked on backend ${pid}`);
}

const referenceKinds = ["persona", "persona-json", "agent", "spec", "snapshot", "native-session"] as const;
type ReferenceKind = typeof referenceKinds[number];

describe.skipIf(!localMinutesDb)("shared voice references (isolated real Postgres)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let personaId: string;
  let secondPersonaId: string;
  const createdVoices: string[] = [];
  const globalPersonas: string[] = [];

  beforeEach(async () => {
    voiceFault = null;
    faultHits = 0;
    expect(fixtures.db).toBe(db);
    f = minutesFixture();
    other = minutesFixture();
    await f.create();
    await other.create();
    personaId = (await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).personaId;
    secondPersonaId = (await db.persona.create({
      data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second persona", data: {} },
    })).id;
    objects.clear();
    deleted.length = 0;
    reads.length = 0;
    createdVoices.length = 0;
    globalPersonas.length = 0;
    putObject.mockClear();
    failPut = null;
    failDelete = null;
    beforePut = null;
    beforeDelete = null;
  });

  afterEach(async () => {
    voiceFault = null;
    beforePut = null;
    beforeDelete = null;
    for (const fixture of [other, f]) {
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
    await db.persona.deleteMany({ where: { id: { in: globalPersonas } } });
    await db.voice.deleteMany({ where: { id: { in: createdVoices } } });
  });

  function audio() {
    return new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])], "reference.wav", { type: "audio/wav" });
  }

  async function voice(orgId: string | null = f.org.id, patch: Prisma.VoiceUpdateInput = {}) {
    const created = await createVoice(orgId, { name: "Reference voice", audio: audio(), transcript: "A short reference passage." });
    createdVoices.push(created.id);
    return Object.keys(patch).length
      ? db.voice.update({ where: { id: created.id }, data: patch }) : created;
  }

  const sessionData = () => ({
    orgId: f.org.id, userId: f.learner.id, agentId: f.roleplay.id, shareCode: randomUUID(),
    personaSlug: f.org.slug, personaVersion: 1, agentSlug: f.roleplay.slug, agentVersion: 1,
  });

  async function addReference(tx: Prisma.TransactionClient, kind: ReferenceKind, voiceId: string) {
    if (kind === "persona") {
      await tx.persona.update({ where: { id: personaId }, data: { voiceId } });
    } else if (kind === "persona-json") {
      await tx.persona.update({ where: { id: personaId }, data: { data: { voiceId } } });
    } else if (kind === "agent") {
      await tx.agent.update({ where: { id: f.roleplay.id }, data: { data: { voiceId } } });
    } else if (kind === "spec") {
      await tx.specVersion.create({
        data: { orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version: 1, data: { voiceId } },
      });
    } else {
      await tx.interviewSession.create({
        data: {
          ...sessionData(),
          ...(kind === "native-session" ? { resolvedVoiceId: voiceId } : { compiledSnapshot: { persona: { voiceId } } }),
        },
      });
    }
  }

  test("two personas share one unchanged Voice and storage set; reselection is idempotent", async () => {
    const selected = await voice();
    const beforeObjects = new Map(objects);
    const beforePuts = putObject.mock.calls.length;
    const beforeCount = await db.voice.count({ where: { orgId: f.org.id } });
    await attachPersonaVoice(f.org.id, f.org.slug, selected.id);
    await attachPersonaVoice(f.org.id, `${f.org.slug}-second`, selected.id);
    const firstSave = await db.persona.findUniqueOrThrow({ where: { id: personaId } });
    expect(await attachPersonaVoice(f.org.id, f.org.slug, selected.id)).toEqual({ voiceId: selected.id, name: selected.name });
    expect((await db.persona.findUniqueOrThrow({ where: { id: personaId } })).updatedAt).toEqual(firstSave.updatedAt);
    expect(await db.voice.count({ where: { orgId: f.org.id } })).toBe(beforeCount);
    expect((await db.voice.findUniqueOrThrow({ where: { id: selected.id }, include: { personas: true } })).personas.map((persona) => persona.id).sort())
      .toEqual([personaId, secondPersonaId].sort());
    expect(await db.voice.findUniqueOrThrow({ where: { id: selected.id } })).toEqual(selected);
    expect(objects).toEqual(beforeObjects);
    expect(putObject.mock.calls.length).toBe(beforePuts);
    expect(reads).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("switching one attachment preserves the other persona and both recordings", async () => {
    const first = await voice();
    const second = await voice();
    const beforeObjects = new Map(objects);
    await attachPersonaVoice(f.org.id, f.org.slug, first.id);
    await attachPersonaVoice(f.org.id, `${f.org.slug}-second`, first.id);
    await attachPersonaVoice(f.org.id, f.org.slug, second.id);
    expect((await db.persona.findUniqueOrThrow({ where: { id: personaId } })).voiceId).toBe(second.id);
    expect((await db.persona.findUniqueOrThrow({ where: { id: secondPersonaId } })).voiceId).toBe(first.id);
    expect(await db.voice.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);
    expect(objects).toEqual(beforeObjects);
    expect(deleted).toEqual([]);
  });

  test("concurrent reselection of the same voice is idempotent without copying files", async () => {
    const selected = await voice();
    const beforeObjects = new Map(objects);
    const results = await Promise.all(Array.from({ length: 8 }, () => attachPersonaVoice(f.org.id, f.org.slug, selected.id)));
    expect(results.every((result) => result.voiceId === selected.id)).toBe(true);
    expect(await db.voice.count({ where: { orgId: f.org.id } })).toBe(1);
    expect(objects).toEqual(beforeObjects);
    expect(reads).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("eligibility is org-scoped and ready-only; global clones stay privileged and samples stay read-only", async () => {
    const own = await voice();
    const foreign = await voice(other.org.id);
    const globalClone = await voice(null);
    const sample = await voice(null, { kind: "sample" });
    const failed = await voice(f.org.id, { status: "failed" });
    const empty = await voice(f.org.id, { s3AudioKey: "" });
    const pending = await voice(f.org.id, { status: "pending" });
    const deleting = await voice(f.org.id, { status: "deleting" });
    expect((await db.voice.findMany({ where: { id: { in: createdVoices }, ...availableVoiceWhere(f.org.id) } })).map((row) => row.id).sort())
      .toEqual([own.id, sample.id].sort());
    for (const unavailable of [foreign, globalClone, failed, empty, pending, deleting]) {
      await expect(attachPersonaVoice(f.org.id, f.org.slug, unavailable.id)).rejects.toMatchObject({ code: "voice_unavailable" });
      await expect(Promise.resolve(db.persona.update({ where: { id: personaId }, data: { voiceId: unavailable.id } }))).rejects.toThrow();
    }
    await attachPersonaVoice(f.org.id, f.org.slug, sample.id);
    await expect(renameVoice(f.org.id, sample.id, "Changed")).rejects.toMatchObject({ status: 404 });
    await expect(deleteVoice(f.org.id, sample.id)).rejects.toMatchObject({ status: 404 });
    const global = await db.persona.create({ data: { slug: `voice-test-${randomUUID()}`, name: "Global", data: {} } });
    globalPersonas.push(global.id);
    await attachPersonaVoice(null, global.slug, globalClone.id);
    expect((await db.persona.findUniqueOrThrow({ where: { id: global.id } })).voiceId).toBe(globalClone.id);
  });

  test("pending uploads are not selectable and failed transcript persistence cleans only the new upload", async () => {
    const existing = await voice();
    const beforeObjects = new Map(objects);
    beforePut = async () => {
      const pending = await db.voice.findMany({ where: { orgId: f.org.id, status: "pending" } });
      expect(pending).toHaveLength(1);
      expect(pending[0].s3AudioKey.startsWith(`${s3.voicePrefix(f.org.id, pending[0].id)}/reference-`)).toBe(true);
      expect(pending[0].s3TranscriptKey?.startsWith(`${s3.voicePrefix(f.org.id, pending[0].id)}/transcript-`)).toBe(true);
      expect(await db.voice.count({ where: { id: pending[0].id, ...availableVoiceWhere(f.org.id) } })).toBe(0);
    };
    failPut = /transcript/;
    await expect(createVoice(f.org.id, { name: "Failed upload", audio: audio(), transcript: "Hello" })).rejects.toThrow("Reference storage failed");
    expect(await db.voice.findMany({ where: { orgId: f.org.id } })).toEqual([existing]);
    expect(objects).toEqual(beforeObjects);
    expect(deleted.every((key) => key !== existing.s3AudioKey && key !== existing.s3TranscriptKey)).toBe(true);
  });

  test("failed upload cleanup preserves canonical retry keys until deleteVoice succeeds", async () => {
    const retained = await voice();
    const beforeObjects = new Map(objects);
    beforePut = async () => {
      const pending = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, status: "pending" } });
      if (!createdVoices.includes(pending.id)) createdVoices.push(pending.id);
    };
    beforeDelete = async (key) => {
      const retiring = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, status: "deleting" } });
      expect([retiring.s3AudioKey, retiring.s3TranscriptKey]).toContain(key);
    };
    failPut = /transcript/;
    failDelete = /reference/;
    await expect(createVoice(f.org.id, { name: "Retryable upload", audio: audio(), transcript: "Original reference passage." })).rejects.toMatchObject({
      code: "voice_delete_retryable",
      status: 503,
      cause: {
        errors: [
          expect.objectContaining({ message: "Reference storage failed" }),
          expect.objectContaining({ message: "Reference deletion failed" }),
        ],
        cause: expect.objectContaining({ message: "Reference storage failed" }),
      },
    });
    const retiring = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, name: "Retryable upload" } });
    expect(retiring.status).toBe("deleting");
    expect(retiring.s3AudioKey).toBe(putObject.mock.calls[2][0]);
    expect(retiring.s3TranscriptKey).toBe(putObject.mock.calls[3][0]);
    expect(retiring.s3AudioKey.startsWith(`${s3.voicePrefix(f.org.id, retiring.id)}/`)).toBe(true);
    expect(objects.has(retiring.s3AudioKey)).toBe(true);
    expect(objects.has(retiring.s3TranscriptKey!)).toBe(false);
    expect(await db.voice.count({ where: { id: retiring.id, ...availableVoiceWhere(f.org.id) } })).toBe(0);
    await expect(attachPersonaVoice(f.org.id, f.org.slug, retiring.id)).rejects.toMatchObject({ code: "voice_unavailable" });
    expect(await db.voice.findUniqueOrThrow({ where: { id: retained.id } })).toEqual(retained);
    failDelete = null;
    beforePut = null;
    beforeDelete = null;
    await deleteVoice(f.org.id, retiring.id);
    expect(await db.voice.findUnique({ where: { id: retiring.id } })).toBeNull();
    expect(objects).toEqual(beforeObjects);
  });

  test("failed upload finalization retains its deleting row after object cleanup and supports retry", async () => {
    beforePut = async () => {
      const pending = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, status: "pending" } });
      if (!createdVoices.includes(pending.id)) createdVoices.push(pending.id);
    };
    failPut = /transcript/;
    voiceFault = { orgId: f.org.id, operation: "finalization" };
    await expect(createVoice(f.org.id, { name: "Retry finalization", audio: audio(), transcript: "Reference passage." })).rejects.toMatchObject({
      code: "voice_delete_retryable",
      status: 503,
      cause: {
        errors: [
          expect.objectContaining({ message: "Reference storage failed" }),
          expect.objectContaining({ message: "Retirement finalization failed" }),
        ],
      },
    });
    expect(faultHits).toBe(1);
    const retiring = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, name: "Retry finalization" } });
    expect(retiring).toMatchObject({
      status: "deleting", s3AudioKey: putObject.mock.calls[0][0], s3TranscriptKey: putObject.mock.calls[1][0],
    });
    expect(objects.size).toBe(0);
    await deleteVoice(f.org.id, retiring.id);
    expect(await db.voice.findUnique({ where: { id: retiring.id } })).toBeNull();
    expect(objects.size).toBe(0);
  });

  test("failed upload retirement persistence surfaces both errors and keeps durable reference keys for recovery", async () => {
    beforePut = async () => {
      const pending = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, status: "pending" } });
      if (!createdVoices.includes(pending.id)) createdVoices.push(pending.id);
    };
    failPut = /transcript/;
    voiceFault = { orgId: f.org.id, operation: "retirement" };
    await expect(createVoice(f.org.id, { name: "Retirement persistence", audio: audio(), transcript: "Reference passage." })).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "Reference storage failed" }),
        expect.objectContaining({ message: "Retirement state failed" }),
      ],
      cause: expect.objectContaining({ message: "Reference storage failed" }),
    });
    expect(faultHits).toBe(1);
    const pending = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, name: "Retirement persistence" } });
    expect(pending).toMatchObject({
      status: "pending", s3AudioKey: putObject.mock.calls[0][0], s3TranscriptKey: putObject.mock.calls[1][0],
    });
    expect(objects.has(putObject.mock.calls[0][0])).toBe(true);
    expect(deleted).toEqual([]);
    expect(await db.voice.count({ where: { id: pending.id, ...availableVoiceWhere(f.org.id) } })).toBe(0);
    await deleteVoice(f.org.id, pending.id);
    expect(await db.voice.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(objects.size).toBe(0);
  });

  test("an ambiguous ready response cannot retire an already committed ready voice", async () => {
    beforePut = async () => {
      const pending = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, status: "pending" } });
      if (!createdVoices.includes(pending.id)) createdVoices.push(pending.id);
    };
    voiceFault = { orgId: f.org.id, operation: "ready-response" };
    await expect(createVoice(f.org.id, { name: "Ambiguous readiness", audio: audio(), transcript: "Reference passage." })).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "Ready response lost" }),
        expect.objectContaining({ code: "P2025" }),
      ],
      cause: expect.objectContaining({ message: "Ready response lost" }),
    });
    expect(faultHits).toBe(1);
    const ready = await db.voice.findFirstOrThrow({ where: { orgId: f.org.id, name: "Ambiguous readiness" } });
    expect(ready).toMatchObject({
      status: "ready", s3AudioKey: putObject.mock.calls[0][0], s3TranscriptKey: putObject.mock.calls[1][0],
    });
    expect(objects.has(ready.s3AudioKey)).toBe(true);
    expect(objects.has(ready.s3TranscriptKey!)).toBe(true);
    expect(deleted).toEqual([]);
  });

  test("same-org non-voice keys cannot be attached or deleted through a Voice", async () => {
    for (const key of [
      `${s3.orgPrefix(f.org.id)}/knowledge/book/source.wav`,
      `${s3.orgPrefix(f.org.id)}/avatars/avatar-id/video/reference.mp4`,
      `${s3.voicePrefix(f.org.id, "another-voice")}/reference.wav`,
    ]) {
      const invalid = await voice(f.org.id, { s3AudioKey: key });
      await expect(attachPersonaVoice(f.org.id, f.org.slug, invalid.id)).rejects.toMatchObject({ code: "voice_asset_invalid" });
      await expect(deleteVoice(f.org.id, invalid.id)).rejects.toMatchObject({ code: "voice_asset_invalid" });
      expect((await db.voice.findUniqueOrThrow({ where: { id: invalid.id } })).status).toBe("ready");
    }
    const invalidTranscript = await voice(f.org.id, { s3TranscriptKey: `${s3.orgPrefix(f.org.id)}/knowledge/book/source.txt` });
    await expect(deleteVoice(f.org.id, invalidTranscript.id)).rejects.toMatchObject({ code: "voice_asset_invalid" });
    expect(deleted).toEqual([]);
  });

  test("listing excludes whitespace, foreign-folder and malformed transcript keys without reading storage", async () => {
    const valid = await voice();
    await voice(f.org.id, { s3AudioKey: " \t\n " });
    await voice(f.org.id, { s3AudioKey: `${s3.orgPrefix(f.org.id)}/knowledge/book/source.wav` });
    await voice(f.org.id, { s3TranscriptKey: `${s3.orgPrefix(f.org.id)}/avatars/avatar-id/photo.jpg` });
    await voice(f.org.id, { status: "deleting" });
    const beforePuts = putObject.mock.calls.length;
    expect((await listAvailableVoices(f.org.id)).filter((row) => createdVoices.includes(row.id)).map((row) => row.id)).toEqual([valid.id]);
    expect(putObject.mock.calls.length).toBe(beforePuts);
    expect(reads).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test.each(["missing", "failed", "empty", "foreign"] as const)("preserving %s historical voice data does not block a settings save or permit live use", async (state) => {
    const selected = state === "missing" ? null
      : state === "foreign" ? await voice(other.org.id)
        : await voice(f.org.id, state === "failed" ? { status: "failed" } : { s3AudioKey: "" });
    const voiceId = selected?.id ?? `missing-history-${randomUUID()}`;
    const historical = { name: "Original trainer", voiceId, custom: { original: true }, objective: "Original setting" };
    const saved = await db.$transaction(async (tx) => {
      const history = await tx.specVersion.create({
        data: { orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version: 1, data: historical },
      });
      await tx.agent.update({ where: { id: f.roleplay.id }, data: { version: 2, data: { objective: "Updated setting" } } });
      return history;
    });
    expect((await db.specVersion.findUniqueOrThrow({ where: { id: saved.id } })).data).toEqual(historical);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).data).toEqual({ objective: "Updated setting" });
    await expect(Promise.resolve(db.agent.update({ where: { id: f.roleplay.id }, data: { data: historical } }))).rejects.toThrow();
    await expect(attachPersonaVoice(f.org.id, f.org.slug, voiceId)).rejects.toMatchObject({ code: "voice_unavailable" });
    if (selected) expect(await db.voice.findUniqueOrThrow({ where: { id: selected.id } })).toEqual(selected);
  });

  test.each(referenceKinds)("%s references block deletion and identity/reference mutation without touching storage", async (kind) => {
    const selected = await voice();
    await db.$transaction((tx) => addReference(tx, kind, selected.id));
    await expect(deleteVoice(f.org.id, selected.id)).rejects.toMatchObject({ code: "voice_in_use", status: 409 });
    await expect(Promise.resolve(db.voice.delete({ where: { id: selected.id } }))).rejects.toThrow();
    for (const data of [
      { orgId: other.org.id }, { status: "failed" }, { kind: "sample" }, { s3AudioKey: `${selected.s3AudioKey}.changed` },
      { s3TranscriptKey: null }, { id: `${selected.id}-changed` },
    ]) {
      await expect(Promise.resolve(db.voice.update({ where: { id: selected.id }, data }))).rejects.toThrow();
    }
    await renameVoice(f.org.id, selected.id, "A reusable name");
    expect((await db.voice.findUniqueOrThrow({ where: { id: selected.id } })).name).toBe("A reusable name");
    expect(objects.has(selected.s3AudioKey)).toBe(true);
    expect(deleted).toEqual([]);
  });

  test.each([
    (id: string) => ({ voiceId: id }),
    (id: string) => ({ voice: id }),
    (id: string) => ({ voice: { id } }),
    (id: string) => ({ agent: { data: { voiceId: id } } }),
    (id: string) => ({ persona: { voiceId: id } }),
    (id: string) => ({ persona: { data: { voiceId: id } } }),
  ])("known historical snapshot shape %# protects the recorded voice", async (snapshot) => {
    const selected = await voice();
    await f.session({ compiledSnapshot: snapshot(selected.id) });
    await expect(deleteVoice(f.org.id, selected.id)).rejects.toMatchObject({ code: "voice_in_use" });
    expect(deleted).toEqual([]);
  });

  test("session voice pin is immutable, scoped and independent of later persona selections", async () => {
    const first = await voice();
    const second = await voice();
    const foreign = await voice(other.org.id);
    await attachPersonaVoice(f.org.id, f.org.slug, first.id);
    const session = await f.session({ resolvedVoiceId: first.id });
    await attachPersonaVoice(f.org.id, f.org.slug, second.id);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).resolvedVoiceId).toBe(first.id);
    for (const voiceId of [second.id, null, foreign.id]) {
      await expect(Promise.resolve(db.interviewSession.update({ where: { id: session.id }, data: { resolvedVoiceId: voiceId } }))).rejects.toThrow();
    }
    await expect(Promise.resolve(f.session({ resolvedVoiceId: foreign.id }))).rejects.toThrow();
    await expect(deleteVoice(f.org.id, first.id)).rejects.toMatchObject({ code: "voice_in_use" });
  });

  test("avatars remain exclusive while their personas can share a voice", async () => {
    const selected = await voice();
    const avatar = await db.avatar.create({ data: { orgId: f.org.id, name: "Exclusive avatar" } });
    await db.persona.update({ where: { id: personaId }, data: { avatarId: avatar.id, voiceId: selected.id } });
    await db.persona.update({ where: { id: secondPersonaId }, data: { voiceId: selected.id } });
    await expect(Promise.resolve(db.persona.update({ where: { id: secondPersonaId }, data: { avatarId: avatar.id } }))).rejects.toThrow();
    await expect(Promise.resolve(db.avatar.update({ where: { id: avatar.id }, data: { orgId: other.org.id } }))).rejects.toThrow();
  });

  test("unused deletion removes only the owned row and its stored references", async () => {
    const selected = await voice();
    const retained = await voice();
    await deleteVoice(f.org.id, selected.id);
    expect(await db.voice.findUnique({ where: { id: selected.id } })).toBeNull();
    expect(objects.has(selected.s3AudioKey)).toBe(false);
    expect(objects.has(retained.s3AudioKey)).toBe(true);
    expect(deleted.sort()).toEqual([selected.s3AudioKey, selected.s3TranscriptKey!].sort());
  });

  test("partial storage failure retains a deleting row with immutable keys and succeeds on retry", async () => {
    const selected = await voice();
    failDelete = /transcript/;
    beforeDelete = async () => {
      expect((await db.voice.findUniqueOrThrow({ where: { id: selected.id } })).status).toBe("deleting");
    };
    await expect(deleteVoice(f.org.id, selected.id)).rejects.toMatchObject({ code: "voice_delete_retryable", status: 503 });
    expect(await db.voice.findUniqueOrThrow({ where: { id: selected.id } })).toMatchObject({
      status: "deleting", s3AudioKey: selected.s3AudioKey, s3TranscriptKey: selected.s3TranscriptKey,
    });
    expect(objects.has(selected.s3AudioKey)).toBe(false);
    expect(objects.has(selected.s3TranscriptKey!)).toBe(true);
    expect(await db.voice.count({ where: { id: selected.id, ...availableVoiceWhere(f.org.id) } })).toBe(0);
    await expect(attachPersonaVoice(f.org.id, f.org.slug, selected.id)).rejects.toMatchObject({ code: "voice_unavailable" });
    await expect(renameVoice(f.org.id, selected.id, "Changed")).rejects.toMatchObject({ code: "voice_deleting" });
    for (const data of [
      { status: "ready" }, { orgId: other.org.id }, { s3AudioKey: `${selected.s3AudioKey}.changed` }, { s3TranscriptKey: null },
    ]) {
      await expect(Promise.resolve(db.voice.update({ where: { id: selected.id }, data }))).rejects.toThrow();
    }
    failDelete = null;
    await deleteVoice(f.org.id, selected.id);
    expect(await db.voice.findUnique({ where: { id: selected.id } })).toBeNull();
    expect(objects.size).toBe(0);
  });

  test("committed deleting status denies every new reference while storage cleanup is in flight", async () => {
    const selected = await voice();
    const entered = barrier();
    const release = barrier();
    beforeDelete = async () => {
      entered.resolve();
      await release.promise;
    };
    const deleting = deleteVoice(f.org.id, selected.id);
    await entered.promise;
    try {
      expect((await db.voice.findUniqueOrThrow({ where: { id: selected.id } })).status).toBe("deleting");
      for (const kind of referenceKinds) {
        await expect(db.$transaction((tx) => addReference(tx, kind, selected.id))).rejects.toThrow();
      }
    } finally {
      release.resolve();
      await deleting;
    }
    expect(await db.voice.findUnique({ where: { id: selected.id } })).toBeNull();
    expect(objects.size).toBe(0);
  });

  test("concurrent deletion is idempotent and only cleans the same voice's immutable files", async () => {
    const selected = await voice();
    const retained = await voice();
    const bothEntered = barrier();
    const release = barrier();
    let calls = 0;
    beforeDelete = async () => {
      if (++calls === 4) bothEntered.resolve();
      await release.promise;
    };
    const deleting = Promise.all([deleteVoice(f.org.id, selected.id), deleteVoice(f.org.id, selected.id)]);
    await bothEntered.promise;
    try {
      expect((await db.voice.findUniqueOrThrow({ where: { id: selected.id } })).status).toBe("deleting");
      expect(await db.voice.findUniqueOrThrow({ where: { id: retained.id } })).toEqual(retained);
    } finally {
      release.resolve();
      await deleting;
    }
    expect(await db.voice.findUnique({ where: { id: selected.id } })).toBeNull();
    expect(objects.has(retained.s3AudioKey)).toBe(true);
    expect(objects.has(retained.s3TranscriptKey!)).toBe(true);
    expect(deleted.every((key) => key === selected.s3AudioKey || key === selected.s3TranscriptKey)).toBe(true);
  });

  test.each(referenceKinds)("concurrent %s insertion wins before deletion and keeps all assets", async (kind) => {
    const selected = await voice();
    const entered = barrier();
    const release = barrier();
    let writerPid = 0;
    const writing = db.$transaction(async (tx) => {
      const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      writerPid = connection.pid;
      await addReference(tx, kind, selected.id);
      entered.resolve();
      await release.promise;
    }, { timeout: 10000 });
    await entered.promise;
    const deleting = deleteVoice(f.org.id, selected.id).then(
      () => ({ deleted: true, error: null }),
      (error: unknown) => ({ deleted: false, error }),
    );
    try {
      await waitForBlockedBy(writerPid);
    } finally {
      release.resolve();
      await writing;
    }
    expect(await deleting).toMatchObject({ deleted: false, error: { code: "voice_in_use" } });
    expect(await db.voice.findUnique({ where: { id: selected.id } })).not.toBeNull();
    expect(objects.has(selected.s3AudioKey)).toBe(true);
    expect(deleted).toEqual([]);
  });

  test.each(referenceKinds)("concurrent deletion wins before %s insertion without granting live use", async (kind) => {
    const selected = await voice();
    const entered = barrier();
    const release = barrier();
    let deletingPid = 0;
    const deleting = db.$transaction(async (tx) => {
      const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      deletingPid = connection.pid;
      await tx.voice.delete({ where: { id: selected.id } });
      entered.resolve();
      await release.promise;
    }, { timeout: 10000 });
    await entered.promise;
    const writing = db.$transaction((tx) => addReference(tx, kind, selected.id)).then(
      () => ({ attached: true }),
      (error: unknown) => ({ attached: false, error }),
    );
    try {
      await waitForBlockedBy(deletingPid);
    } finally {
      release.resolve();
      await deleting;
    }
    expect(await writing).toMatchObject({ attached: kind === "spec" });
    if (kind === "spec") {
      expect((await db.specVersion.findFirstOrThrow({ where: { orgId: f.org.id } })).data).toEqual({ voiceId: selected.id });
    }
    expect(await db.voice.findUnique({ where: { id: selected.id } })).toBeNull();
    expect((await db.persona.findUniqueOrThrow({ where: { id: personaId } })).voiceId).toBeNull();
  });

  test("a concurrent readiness change wins before attachment and cannot attach a failed recording", async () => {
    const selected = await voice();
    const entered = barrier();
    const release = barrier();
    let writerPid = 0;
    const updating = db.$transaction(async (tx) => {
      const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      writerPid = connection.pid;
      await tx.voice.update({ where: { id: selected.id }, data: { status: "failed" } });
      entered.resolve();
      await release.promise;
    }, { timeout: 10000 });
    await entered.promise;
    const attaching = attachPersonaVoice(f.org.id, f.org.slug, selected.id).then(
      () => ({ attached: true, error: null }),
      (error: unknown) => ({ attached: false, error }),
    );
    try {
      await waitForBlockedBy(writerPid);
    } finally {
      release.resolve();
      await updating;
    }
    expect(await attaching).toMatchObject({ attached: false, error: { code: "voice_unavailable" } });
    expect((await db.persona.findUniqueOrThrow({ where: { id: personaId } })).voiceId).toBeNull();
    expect(objects.has(selected.s3AudioKey)).toBe(true);
  });
});
