import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { avatarPrefix, deleteObject, getObjectBytes, getObjectText, presignedGetUrl, putObject, voicePrefix } from "@/lib/s3";

/**
 * A persona = voice + avatar + prompt fields (Persona.data) + program settings (Persona.settings).
 * Voice: reference audio (+ transcript) sent to voice cloning. Avatar: reference image and video for the
 * AI avatar model. Each persona owns its own voice and avatar (unique FKs, same org: DB trigger).
 * `orgId: null` targets a global preset persona.
 */

export class PersonaMediaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MB = 1024 * 1024;
export const MEDIA_LIMITS = {
  audio: { maxBytes: 25 * MB, types: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/webm", "audio/ogg"] },
  image: { maxBytes: 10 * MB, types: ["image/jpeg", "image/png", "image/webp"] },
  video: { maxBytes: 100 * MB, types: ["video/mp4", "video/webm", "video/quicktime"] },
} as const;
const EXTENSION: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/webm": "webm", "audio/ogg": "ogg",
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

/** Program settings: runtime behaviour the agent never reads. Stored now; the backend acts on them later. */
export const personaSettingsSchema = z.object({
  pace: z.enum(["slow", "normal", "fast"]).default("normal"),
}).strict();
export type PersonaSettings = z.infer<typeof personaSettingsSchema>;

function checkFile(file: File, kind: keyof typeof MEDIA_LIMITS) {
  const limit = MEDIA_LIMITS[kind];
  if (!file.size) throw new PersonaMediaError(`The ${kind} file is empty.`);
  if (file.size > limit.maxBytes) throw new PersonaMediaError(`The ${kind} file must be ${limit.maxBytes / MB} MB or smaller.`);
  if (!(limit.types as readonly string[]).includes(file.type)) {
    throw new PersonaMediaError(`Unsupported ${kind} type. Use ${limit.types.map((type) => EXTENSION[type]).filter((ext, i, all) => all.indexOf(ext) === i).join(", ")}.`);
  }
  return EXTENSION[file.type];
}

async function findPersona(orgId: string | null, slug: string) {
  const persona = await db.persona.findFirst({
    where: { orgId, slug },
    select: { id: true, orgId: true, name: true, voiceId: true, avatarId: true, settings: true },
  });
  if (!persona) throw new PersonaMediaError("Persona not found", 404);
  return persona;
}

/** Best-effort removal of a replaced file; the DB already points at its replacement. */
async function removeOld(key: string | null | undefined) {
  if (!key) return;
  await deleteObject(key).catch((error) => console.warn("[persona-media] could not delete replaced file", key, error));
}

/** Sets the persona's voice: its reference audio (and optional transcript). Creates the voice on first use. */
export async function setPersonaVoice(orgId: string | null, slug: string, input: { audio: File; transcript?: string }) {
  const ext = checkFile(input.audio, "audio");
  const transcript = input.transcript?.trim() ?? "";
  if (transcript.length > 5000) throw new PersonaMediaError("The transcript must be 5000 characters or fewer.");
  const persona = await findPersona(orgId, slug);

  const created = !persona.voiceId;
  const voice = persona.voiceId
    ? await db.voice.findUniqueOrThrow({ where: { id: persona.voiceId }, select: { id: true, s3AudioKey: true, s3TranscriptKey: true } })
    : await db.voice.create({ data: { orgId, name: `${persona.name} voice`, kind: "cloned", s3AudioKey: "" }, select: { id: true, s3AudioKey: true, s3TranscriptKey: true } });

  // Unique keys per upload: a failed replacement never touches the voice in use, and caches can't serve stale audio.
  const stamp = randomUUID();
  const prefix = voicePrefix(orgId, voice.id);
  const audioKey = `${prefix}/reference-${stamp}.${ext}`;
  const transcriptKey = transcript ? `${prefix}/transcript-${stamp}.txt` : null;
  try {
    await putObject(audioKey, new Uint8Array(await input.audio.arrayBuffer()), input.audio.type);
    if (transcriptKey) await putObject(transcriptKey, transcript, "text/plain; charset=utf-8");
    await db.voice.update({ where: { id: voice.id }, data: { s3AudioKey: audioKey, s3TranscriptKey: transcriptKey, status: "ready" } });
    // Conditional: a parallel first upload may have linked its own voice already.
    if (created && (await db.persona.updateMany({ where: { id: persona.id, voiceId: null }, data: { voiceId: voice.id } })).count !== 1) {
      throw new PersonaMediaError("The voice changed while uploading. Try again.", 409);
    }
  } catch (error) {
    await removeOld(audioKey);
    if (transcriptKey) await removeOld(transcriptKey);
    if (created) await db.voice.delete({ where: { id: voice.id } }).catch(() => {});
    throw error;
  }
  await removeOld(voice.s3AudioKey);
  if (voice.s3TranscriptKey !== transcriptKey) await removeOld(voice.s3TranscriptKey);
  return { voiceId: voice.id };
}

/**
 * Voices a role-play persona can take from the voice library: built-in samples and the org's cloned voices that no
 * persona owns (a persona's own voice is not offered to another).
 */
export function pickableVoices(orgId: string) {
  return db.voice.findMany({
    where: { status: "ready", persona: null, OR: [{ orgId: null, kind: "sample" }, { orgId, kind: "cloned" }] },
    orderBy: [{ kind: "desc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true },
  });
}

/**
 * Gives the persona a voice from the library. A persona owns its voice (one persona per voice, same org), so the
 * chosen voice's reference audio + transcript are copied into the persona's own voice, which takes its name.
 */
export async function setPersonaVoiceFrom(orgId: string, slug: string, sourceVoiceId: string) {
  const source = (await pickableVoices(orgId)).find((voice) => voice.id === sourceVoiceId);
  if (!source) throw new PersonaMediaError("That voice is not available.", 404);
  const row = await db.voice.findUniqueOrThrow({ where: { id: source.id }, select: { s3AudioKey: true, s3TranscriptKey: true } });
  const [audio, transcript] = await Promise.all([
    getObjectBytes(row.s3AudioKey),
    row.s3TranscriptKey ? getObjectText(row.s3TranscriptKey) : Promise.resolve(""),
  ]);
  const ext = row.s3AudioKey.split(".").pop()?.toLowerCase() ?? "wav";
  const type = Object.entries(EXTENSION).find(([mime, e]) => e === ext && MEDIA_LIMITS.audio.types.includes(mime as never))?.[0] ?? "audio/wav";
  const { voiceId } = await setPersonaVoice(orgId, slug, { audio: new File([new Uint8Array(audio)], `reference.${ext}`, { type }), transcript });
  await db.voice.update({ where: { id: voiceId }, data: { name: source.name } });
  return { voiceId, name: source.name };
}

/** Sets the persona's avatar reference image and/or video. Creates the avatar on first use. */
export async function setPersonaAvatar(orgId: string | null, slug: string, input: { image?: File; video?: File }) {
  if (!input.image && !input.video) throw new PersonaMediaError("Add an image or a video.");
  const imageExt = input.image ? checkFile(input.image, "image") : null;
  const videoExt = input.video ? checkFile(input.video, "video") : null;
  const persona = await findPersona(orgId, slug);

  const created = !persona.avatarId;
  const avatar = persona.avatarId
    ? await db.avatar.findUniqueOrThrow({ where: { id: persona.avatarId }, select: { id: true, s3ImageKey: true, s3VideoKey: true } })
    : await db.avatar.create({ data: { orgId, name: `${persona.name} avatar` }, select: { id: true, s3ImageKey: true, s3VideoKey: true } });

  const stamp = randomUUID();
  const prefix = avatarPrefix(orgId, avatar.id);
  const imageKey = input.image ? `${prefix}/image/${stamp}.${imageExt}` : null;
  const videoKey = input.video ? `${prefix}/video/${stamp}.${videoExt}` : null;
  try {
    if (input.image && imageKey) await putObject(imageKey, new Uint8Array(await input.image.arrayBuffer()), input.image.type);
    if (input.video && videoKey) await putObject(videoKey, new Uint8Array(await input.video.arrayBuffer()), input.video.type);
    await db.avatar.update({
      where: { id: avatar.id },
      data: { ...(imageKey ? { s3ImageKey: imageKey } : {}), ...(videoKey ? { s3VideoKey: videoKey } : {}) },
    });
    if (created && (await db.persona.updateMany({ where: { id: persona.id, avatarId: null }, data: { avatarId: avatar.id } })).count !== 1) {
      throw new PersonaMediaError("The avatar changed while uploading. Try again.", 409);
    }
  } catch (error) {
    await removeOld(imageKey);
    await removeOld(videoKey);
    if (created) await db.avatar.delete({ where: { id: avatar.id } }).catch(() => {});
    throw error;
  }
  if (imageKey) await removeOld(avatar.s3ImageKey);
  if (videoKey) await removeOld(avatar.s3VideoKey);
  return { avatarId: avatar.id };
}

/** Stores program settings (validated). */
export async function setPersonaSettings(orgId: string | null, slug: string, input: unknown): Promise<PersonaSettings> {
  const parsed = personaSettingsSchema.safeParse(input);
  if (!parsed.success) throw new PersonaMediaError(parsed.error.issues[0]?.message ?? "Invalid settings");
  const persona = await findPersona(orgId, slug);
  await db.persona.update({ where: { id: persona.id }, data: { settings: parsed.data as Prisma.InputJsonValue } });
  return parsed.data;
}

/**
 * Each agent's face for call screens: a presigned link to its persona's avatar photo (or null). Presigned rather than the
 * same-site avatar route, so learners who are not yet org members (twin share links) can see it. Six hours covers a call.
 */
export async function agentPhotoUrls(orgId: string, agentSlugs: string[]): Promise<Record<string, string | null>> {
  if (!agentSlugs.length) return {};
  const agents = await db.agent.findMany({
    where: { slug: { in: agentSlugs }, OR: [{ orgId }, { orgId: null }] },
    select: { slug: true, persona: { select: { avatar: { select: { s3ImageKey: true } } } } },
  });
  const entries = await Promise.all(agents.map(async (agent) => {
    const key = agent.persona.avatar?.s3ImageKey;
    return [agent.slug, key ? await presignedGetUrl(key, 6 * 3600) : null] as const;
  }));
  return Object.fromEntries(entries);
}

/** Everything the program side needs: short-lived file links, the voice transcript and settings. */
export async function getPersonaMedia(orgId: string | null, slug: string) {
  const persona = await db.persona.findFirst({
    where: { orgId, slug },
    select: {
      settings: true,
      voice: { select: { id: true, s3AudioKey: true, s3TranscriptKey: true } },
      avatar: { select: { id: true, s3ImageKey: true, s3VideoKey: true } },
    },
  });
  if (!persona) throw new PersonaMediaError("Persona not found", 404);
  const link = (key: string | null | undefined) => (key ? presignedGetUrl(key) : Promise.resolve(null));
  const [audioUrl, transcript, imageUrl, videoUrl] = await Promise.all([
    link(persona.voice?.s3AudioKey),
    persona.voice?.s3TranscriptKey ? getObjectText(persona.voice.s3TranscriptKey) : Promise.resolve(null),
    link(persona.avatar?.s3ImageKey),
    link(persona.avatar?.s3VideoKey),
  ]);
  const settings = personaSettingsSchema.safeParse(persona.settings ?? {});
  return {
    voice: persona.voice && audioUrl ? { id: persona.voice.id, audioUrl, transcript } : null,
    avatar: persona.avatar && (imageUrl || videoUrl) ? { id: persona.avatar.id, imageUrl, videoUrl } : null,
    settings: settings.success ? settings.data : personaSettingsSchema.parse({}),
  };
}
