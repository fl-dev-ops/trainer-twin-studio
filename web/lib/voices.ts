import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Prisma, Voice } from "@/lib/generated/prisma/client";
import { deleteObject, putObject, voicePrefix } from "@/lib/s3";

const MB = 1024 * 1024;
const AUDIO_EXTENSIONS = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
} as const;
export const VOICE_AUDIO_LIMITS = { maxBytes: 25 * MB, types: Object.keys(AUDIO_EXTENSIONS) } as const;

export class VoiceError extends AppError {}

export function availableVoiceWhere(orgId: string | null): Prisma.VoiceWhereInput {
  return {
    status: "ready",
    s3AudioKey: { not: "" },
    OR: orgId === null ? [{ orgId: null }] : [{ orgId }, { orgId: null, kind: "sample" }],
  };
}

/**
 * A voice's files must live in that voice's own folder: `<base>/<org id>/tts-voices/<voice id>/<file>` for an org voice,
 * `<base>/global/...` (or `<app>/shared/...` for a built-in sample) for a global one. The leading base is not checked:
 * it differs by environment and has changed over time (trainertwin/kb, prod/trainertwin/kb, trainertwin-dev/kb), and
 * rows keep the key they were written with. What matters is that a voice never points at another org's or another
 * voice's files, and that no key escapes its folder.
 */
export function hasValidVoiceObjectKeys(voice: Pick<Voice, "id" | "orgId" | "kind" | "s3AudioKey" | "s3TranscriptKey">) {
  const scopes = voice.orgId === null ? ["global", ...(voice.kind === "sample" ? ["shared"] : [])] : [voice.orgId];
  return [voice.s3AudioKey, ...(voice.s3TranscriptKey === null ? [] : [voice.s3TranscriptKey])].every((key) => {
    if (!key.trim() || key.includes("\\") || key.startsWith("/")) return false;
    const parts = key.split("/");
    if (parts.some((part) => !part.trim() || part === "." || part === "..")) return false;
    // ... <scope> / tts-voices / <voice id> / <file...>, with at least one base segment before the scope.
    const at = parts.lastIndexOf("tts-voices");
    return at >= 2 && parts[at + 1] === voice.id && parts.length > at + 2 && scopes.includes(parts[at - 1]);
  });
}

export function assertVoiceObjectKeys(voice: Pick<Voice, "id" | "orgId" | "kind" | "s3AudioKey" | "s3TranscriptKey">) {
  if (!hasValidVoiceObjectKeys(voice)) {
    throw new VoiceError("voice_asset_invalid", "That voice has an invalid reference file.", 409);
  }
}

export async function listAvailableVoices(orgId: string | null, client: Prisma.TransactionClient = db) {
  const voices = await client.voice.findMany({
    where: availableVoiceWhere(orgId),
    orderBy: [{ kind: "desc" }, { name: "asc" }],
  });
  return voices.filter(hasValidVoiceObjectKeys);
}

export async function findAvailableVoice(orgId: string | null, voiceId: string, client: Prisma.TransactionClient = db) {
  const voice = await client.voice.findFirst({ where: { id: voiceId, ...availableVoiceWhere(orgId) } });
  if (!voice) throw new VoiceError("voice_unavailable", "That voice is not available.", 404);
  assertVoiceObjectKeys(voice);
  return voice;
}

function voiceName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) throw new VoiceError("voice_invalid_input", "The voice name must be 1–60 characters.", 400);
  return trimmed;
}

export async function createVoice(orgId: string | null, input: { name: string; audio: File; transcript?: string }) {
  const name = voiceName(input.name);
  if (!input.audio.size) throw new VoiceError("voice_invalid_input", "The audio file is empty.", 400);
  if (input.audio.size > VOICE_AUDIO_LIMITS.maxBytes) throw new VoiceError("voice_invalid_input", "The audio file must be 25 MB or smaller.", 400);
  const extension = Object.entries(AUDIO_EXTENSIONS).find(([mime]) => mime === input.audio.type)?.[1];
  if (!extension) throw new VoiceError("voice_invalid_input", "Unsupported audio type. Use wav, mp3, m4a, webm, ogg.", 400);
  const transcript = input.transcript?.trim() ?? "";
  if (transcript.length > 5000) throw new VoiceError("voice_invalid_input", "The transcript must be 5000 characters or fewer.", 400);
  const bytes = new Uint8Array(await input.audio.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > VOICE_AUDIO_LIMITS.maxBytes) {
    throw new VoiceError("voice_invalid_input", "The audio file must be non-empty and 25 MB or smaller.", 400);
  }
  const voice = await db.voice.create({ data: { orgId, name, kind: "cloned", status: "pending", s3AudioKey: "" } });
  const prefix = voicePrefix(orgId, voice.id);
  const stamp = randomUUID();
  const audioKey = `${prefix}/reference-${stamp}.${extension}`;
  const transcriptKey = transcript ? `${prefix}/transcript-${stamp}.txt` : null;
  await db.voice.update({
    where: { id: voice.id, orgId, status: "pending" },
    data: { s3AudioKey: audioKey, s3TranscriptKey: transcriptKey },
  });
  try {
    await putObject(audioKey, bytes, input.audio.type);
    if (transcriptKey) await putObject(transcriptKey, transcript, "text/plain; charset=utf-8");
    return await db.voice.update({
      where: { id: voice.id, orgId, status: "pending" },
      data: { status: "ready", s3AudioKey: audioKey, s3TranscriptKey: transcriptKey },
    });
  } catch (error) {
    try {
      await db.voice.update({
        where: { id: voice.id, orgId, status: "pending" },
        data: { status: "deleting" },
      });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Voice upload failed and cleanup was incomplete.", { cause: error });
    }
    const cleanup = await Promise.allSettled([
      deleteObject(audioKey),
      ...(transcriptKey ? [deleteObject(transcriptKey)] : []),
    ]);
    const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw retryableDeletion(new AggregateError([error, ...failures], "Voice upload failed and cleanup was incomplete.", { cause: error }));
    try {
      await db.voice.deleteMany({ where: { id: voice.id, orgId, status: "deleting" } });
    } catch (cleanupError) {
      throw retryableDeletion(new AggregateError([error, cleanupError], "Voice upload failed and cleanup was incomplete.", { cause: error }));
    }
    throw error;
  }
}

export async function attachPersonaVoice(orgId: string | null, slug: string, voiceId: string, client?: Prisma.TransactionClient): Promise<{ voiceId: string; name: string }> {
  if (!client) return db.$transaction((tx) => attachPersonaVoice(orgId, slug, voiceId, tx));
  await client.$queryRaw`SELECT id FROM "Voice" WHERE id = ${voiceId} FOR SHARE`;
  const voice = await findAvailableVoice(orgId, voiceId, client);
  await client.$queryRaw`SELECT id FROM "Persona" WHERE "orgId" IS NOT DISTINCT FROM ${orgId} AND slug = ${slug} FOR UPDATE`;
  const persona = await client.persona.findFirst({ where: { orgId, slug }, select: { id: true, voiceId: true } });
  if (!persona) throw new VoiceError("persona_not_found", "Persona not found", 404);
  if (persona.voiceId !== voice.id) {
    const changed = await client.persona.updateMany({
      where: { id: persona.id, orgId, voiceId: persona.voiceId },
      data: { voiceId: voice.id },
    });
    if (changed.count !== 1) throw new VoiceError("voice_conflict", "The voice changed while saving. Try again.", 409);
  }
  return { voiceId: voice.id, name: voice.name };
}

export async function renameVoice(orgId: string, voiceId: string, name: string) {
  const trimmed = voiceName(name);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Voice" WHERE id = ${voiceId} FOR UPDATE`;
    const voice = await tx.voice.findFirst({ where: { id: voiceId, orgId } });
    if (!voice) throw new VoiceError("voice_not_found", "Voice not found.", 404);
    if (voice.kind !== "cloned") throw new VoiceError("voice_read_only", "Sample voices cannot be renamed.", 403);
    if (voice.status === "deleting") throw new VoiceError("voice_deleting", "Retry deleting this voice before making other changes.", 409);
    return tx.voice.update({ where: { id: voice.id }, data: { name: trimmed }, select: { id: true, name: true } });
  });
}

export async function deleteVoice(orgId: string, voiceId: string) {
  const voice = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Voice" WHERE id = ${voiceId} FOR UPDATE`;
    const voice = await tx.voice.findFirst({ where: { id: voiceId, orgId } });
    if (!voice) throw new VoiceError("voice_not_found", "Voice not found.", 404);
    if (voice.kind !== "cloned") throw new VoiceError("voice_read_only", "Sample voices cannot be deleted.", 403);
    const [usage] = await tx.$queryRaw<{ used: boolean }[]>`SELECT voice_is_referenced(${voiceId}) AS used`;
    if (usage.used) throw new VoiceError("voice_in_use", "That voice is in use and cannot be deleted.", 409);
    assertVoiceObjectKeys(voice);
    if (voice.status !== "deleting") await tx.voice.update({ where: { id: voice.id }, data: { status: "deleting" } });
    return voice;
  }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2003") {
      throw new VoiceError("voice_in_use", "That voice is in use and cannot be deleted.", 409);
    }
    throw error;
  });
  const cleanup = await Promise.allSettled([
    deleteObject(voice.s3AudioKey),
    ...(voice.s3TranscriptKey ? [deleteObject(voice.s3TranscriptKey)] : []),
  ]);
  const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw retryableDeletion(new AggregateError(failures, "Voice reference cleanup failed."));
  try {
    await db.voice.deleteMany({ where: { id: voice.id, orgId, status: "deleting" } });
  } catch (error) {
    throw retryableDeletion(error);
  }
}

function retryableDeletion(cause: unknown) {
  const error = new VoiceError("voice_delete_retryable", "Voice deletion could not finish. Retry deleting this voice.", 503);
  error.cause = cause;
  return error;
}
