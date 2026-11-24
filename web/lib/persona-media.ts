import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { avatarPrefix, deleteObject, getObjectText, presignedGetUrl, putObject } from "@/lib/s3";
import { attachPersonaVoice, createVoice, findAvailableVoice, listAvailableVoices, VOICE_AUDIO_LIMITS } from "@/lib/voices";

/**
 * A persona = voice + avatar + prompt fields (Persona.data) + program settings (Persona.settings).
 * Voice: reference audio (+ transcript) sent to voice cloning. Avatar: reference image and video for the
 * AI avatar model. Voices are reusable; each persona still owns its avatar.
 * `orgId: null` targets a global preset persona.
 */

export class PersonaMediaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MB = 1024 * 1024;
export const MEDIA_LIMITS = {
  audio: VOICE_AUDIO_LIMITS,
  image: { maxBytes: 10 * MB, types: ["image/jpeg", "image/png", "image/webp"] },
  video: { maxBytes: 100 * MB, types: ["video/mp4", "video/webm", "video/quicktime"] },
} as const;
const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

/** Program settings: runtime behaviour the agent never reads. Stored now; the backend acts on them later. */
export const personaSettingsSchema = z.object({
  pace: z.enum(["slow", "normal", "fast"]).default("normal"),
}).strict();
export type PersonaSettings = z.infer<typeof personaSettingsSchema>;

function checkFile(file: File, kind: "image" | "video") {
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
    select: { id: true, orgId: true, name: true, isOwn: true, voiceId: true, avatarId: true, settings: true },
  });
  if (!persona) throw new PersonaMediaError("Persona not found", 404);
  return persona;
}

/** Best-effort removal of a replaced file; the DB already points at its replacement. */
async function removeOld(key: string | null | undefined) {
  if (!key) return;
  await deleteObject(key).catch((error) => console.warn("[persona-media] could not delete replaced file", key, error));
}

/** A recording uploaded for a persona joins the voice library under the name given (never one made from the persona's). */
export async function setPersonaVoice(orgId: string | null, slug: string, input: { name: string; audio: File; transcript?: string }) {
  const persona = await findPersona(orgId, slug);
  const voice = await createVoice(orgId, input);
  await selectPersonaVoice(orgId, slug, persona, voice.id);
  return { voiceId: voice.id };
}

export async function pickableVoices(orgId: string) {
  return (await listAvailableVoices(orgId)).map(({ id, name, kind, language, gender, age, accent }) => ({ id, name, kind, language, gender, age, accent }));
}

export async function setPersonaVoiceFrom(orgId: string, slug: string, sourceVoiceId: string) {
  const persona = await findPersona(orgId, slug);
  return selectPersonaVoice(orgId, slug, persona, sourceVoiceId);
}

async function selectPersonaVoice(orgId: string | null, slug: string, persona: { isOwn: boolean }, voiceId: string) {
  if (orgId !== null && persona.isOwn) {
    const { selectOwnPersonaVoice } = await import("@/lib/twin/avatar");
    const selected = await selectOwnPersonaVoice(orgId, slug, voiceId);
    return { voiceId: selected.voiceId, name: selected.name };
  }
  return attachPersonaVoice(orgId, slug, voiceId);
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
    // Not role plays: their session picks who answers (sessionPersonaView).
    where: { slug: { in: agentSlugs }, OR: [{ orgId }, { orgId: null }], kind: { not: "ROLEPLAY" } },
    select: { slug: true, persona: { select: { avatar: { select: { s3ImageKey: true } } } } },
  });
  const entries = await Promise.all(agents.map(async (agent) => {
    const key = agent.persona.avatar?.s3ImageKey;
    return [agent.slug, key ? await presignedGetUrl(key, 6 * 3600) : null] as const;
  }));
  return Object.fromEntries(entries);
}

/** Who answers a started session, for its call screen: the persona the session recorded (a role play's pick). */
export async function sessionPersonaView(orgId: string, sessionId: string) {
  const session = await db.interviewSession.findFirst({ where: { id: sessionId, orgId }, select: { personaSlug: true } });
  if (!session) return null;
  const persona = await db.persona.findFirst({
    where: { slug: session.personaSlug, OR: [{ orgId }, { orgId: null }] },
    orderBy: { orgId: { sort: "asc", nulls: "last" } },
    select: { slug: true, name: true, data: true, avatar: { select: { s3ImageKey: true } } },
  });
  if (!persona) return null;
  const data = persona.data && typeof persona.data === "object" ? (persona.data as Record<string, unknown>) : {};
  const key = persona.avatar?.s3ImageKey;
  return {
    slug: persona.slug,
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : persona.name,
    photoUrl: key ? await presignedGetUrl(key, 6 * 3600).catch(() => null) : null,
  };
}

/** Everything the program side needs: short-lived file links, the voice transcript and settings. */
export async function getPersonaMedia(orgId: string | null, slug: string) {
  const persona = await db.persona.findFirst({
    where: { orgId, slug },
    select: {
      settings: true,
      voiceId: true,
      avatar: { select: { id: true, s3ImageKey: true, s3VideoKey: true } },
    },
  });
  if (!persona) throw new PersonaMediaError("Persona not found", 404);
  const voice = persona.voiceId ? await findAvailableVoice(orgId, persona.voiceId) : null;
  const link = (key: string | null | undefined) => (key ? presignedGetUrl(key) : Promise.resolve(null));
  const [audioUrl, transcript, imageUrl, videoUrl] = await Promise.all([
    link(voice?.s3AudioKey),
    voice?.s3TranscriptKey ? getObjectText(voice.s3TranscriptKey) : Promise.resolve(null),
    link(persona.avatar?.s3ImageKey),
    link(persona.avatar?.s3VideoKey),
  ]);
  const settings = personaSettingsSchema.safeParse(persona.settings ?? {});
  return {
    voice: voice && audioUrl ? { id: voice.id, audioUrl, transcript } : null,
    avatar: persona.avatar && (imageUrl || videoUrl) ? { id: persona.avatar.id, imageUrl, videoUrl } : null,
    settings: settings.success ? settings.data : personaSettingsSchema.parse({}),
  };
}
