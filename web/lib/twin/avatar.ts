import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { avatarPrefix, deleteObject, deletePrefix, getObjectBytes, presignedGetUrl, presignedPutUrl, putObject, voicePrefix } from "@/lib/s3";
import { professionalHeadshot } from "@/lib/headshot";
import { TWIN_SOURCE } from "@/lib/twins";

/**
 * The trainer's "Voice and avatar" setup on Twin's brain, stored the persona way (migration persona_media):
 * - the persona's own Avatar row: `s3ImageKey` (the photo, the twin's face) and `s3VideoKey` (the take of them reading
 *   the passage on camera, kept as the AI avatar reference);
 * - `Persona.voiceId`: the voice cloned from that take's audio (reference audio + transcript live on the Voice).
 * Twins speak with their persona's voice unless the agent sets its own `voiceId` (see session activation).
 */

export const AVATAR_VIDEO_TYPES = { "video/webm": "webm", "video/mp4": "mp4" } as const;
export type AvatarVideoType = keyof typeof AVATAR_VIDEO_TYPES;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export class AvatarError extends Error {}

const personaSelect = {
  id: true, slug: true, name: true, isOwn: true, voiceId: true,
  avatar: { select: { id: true, s3ImageKey: true, s3OriginalImageKey: true, s3VideoKey: true, updatedAt: true } },
  voice: { select: { name: true } },
} as const;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The persona behind the trainer's main twin (all skills), else their first own persona. */
export async function ownTwinPersona(orgId: string) {
  const main = await db.agent.findFirst({
    where: { orgId, kind: "TWIN", data: { path: ["source"], equals: TWIN_SOURCE } },
    orderBy: { createdAt: "asc" },
    select: { persona: { select: personaSelect } },
  });
  if (main?.persona.isOwn) return main.persona;
  return db.persona.findFirst({ where: { orgId, isOwn: true }, orderBy: { createdAt: "asc" }, select: personaSelect });
}

/** Same-site URL of a persona's photo; `v` changes with every save so browsers never show a stale one. */
export const avatarPhotoUrl = (personaSlug: string, avatar: { s3ImageKey: string | null; updatedAt: Date } | null | undefined) =>
  avatar?.s3ImageKey ? `/api/personas/${encodeURIComponent(personaSlug)}/avatar?v=${avatar.updatedAt.getTime()}` : null;

/** What the Brain card and the capture page show. */
export async function avatarState(orgId: string) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) return null;
  return {
    personaName: persona.name,
    photoUrl: avatarPhotoUrl(persona.slug, persona.avatar),
    hasReference: Boolean(persona.avatar?.s3VideoKey),
    voiceId: persona.voiceId,
    voiceName: persona.voice?.name ?? null,
    updatedAt: persona.avatar?.updatedAt.toISOString() ?? null,
  };
}

/** The persona's Avatar, created and linked on first use (the persona owns it). */
async function ensureAvatar(orgId: string, persona: NonNullable<Awaited<ReturnType<typeof ownTwinPersona>>>) {
  if (persona.avatar) return persona.avatar;
  const avatar = await db.avatar.create({ data: { orgId, name: `${persona.name} avatar` }, select: { id: true } });
  const linked = await db.persona.updateMany({ where: { id: persona.id, avatarId: null }, data: { avatarId: avatar.id } });
  if (linked.count === 1) return avatar;
  // A parallel request linked its own avatar first: use that one.
  await db.avatar.delete({ where: { id: avatar.id } }).catch(() => {});
  const current = await db.persona.findUniqueOrThrow({ where: { id: persona.id }, select: { avatarId: true } });
  return { id: current.avatarId! };
}

const videoFolder = (orgId: string, avatarId: string) => `${avatarPrefix(orgId, avatarId)}/video/`;
/** AI versions of a new photo wait here until one is chosen (moved into place) or the folder is cleared on save. */
const candidateFolder = (orgId: string, avatarId: string) => `${avatarPrefix(orgId, avatarId)}/image/candidates/`;

/**
 * One AI version of a just-taken photo, in one of the HEADSHOT_STYLES looks: stored as a candidate, returned with a
 * short-lived URL to show it. The trainer picks between their photo and these before saving.
 */
export async function makeHeadshot(orgId: string, input: { photo: string; style: number }) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) throw new AvatarError("Set up your twin first");
  const photo = decodePhoto(input.photo);
  const avatar = await ensureAvatar(orgId, persona);
  const headshot = await professionalHeadshot(photo, "image/jpeg", input.style).catch((error) => {
    console.warn("[avatar] headshot failed", error);
    throw new AvatarError("We couldn't make this version");
  });
  const key = `${candidateFolder(orgId, avatar.id)}${randomUUID()}.${headshot.ext}`;
  await putObject(key, headshot.bytes, headshot.mime);
  return { key, url: await presignedGetUrl(key, 3600) };
}

/** Where the browser uploads the reference video (straight to S3), inside the persona's avatar folder. */
export async function avatarVideoUpload(orgId: string, contentType: AvatarVideoType) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) throw new AvatarError("Set up your twin first");
  const avatar = await ensureAvatar(orgId, persona);
  const key = `${videoFolder(orgId, avatar.id)}${randomUUID()}.${AVATAR_VIDEO_TYPES[contentType]}`;
  return { key, url: await presignedPutUrl(key, contentType) };
}

/** The JPEG bytes of a base64 photo (optionally a data URL); throws unless it is a JPEG within the size limit. */
export function decodePhoto(photo: string) {
  const bytes = Buffer.from(photo.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new AvatarError("The photo must be under 2 MB");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new AvatarError("The photo must be a JPEG");
  return new Uint8Array(bytes);
}

/**
 * Saves the twin's picture on the persona's avatar (/twin/brain/avatar). The photo as taken (or uploaded) is kept as
 * the original; the one shown everywhere is the chosen AI version, else that photo.
 */
export async function saveAvatar(orgId: string, input: { photo: string; headshotKey?: string | null }) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) throw new AvatarError("Set up your twin first");
  const photo = decodePhoto(input.photo);
  const avatar = { ...persona.avatar, ...(await ensureAvatar(orgId, persona)) };
  // The chosen AI version must be one of this avatar's candidates.
  const candidates = candidateFolder(orgId, avatar.id);
  const chosen = input.headshotKey ?? null;
  const ext = chosen?.startsWith(candidates) ? /^[0-9a-f-]{36}\.(png|jpg|webp)$/.exec(chosen.slice(candidates.length))?.[1] : null;
  if (chosen && !ext) throw new AvatarError("Unknown photo");

  const stamp = randomUUID();
  const originalKey = `${avatarPrefix(orgId, avatar.id)}/image/original-${stamp}.jpg`;
  await putObject(originalKey, photo, "image/jpeg");
  const imageKey = chosen ? `${avatarPrefix(orgId, avatar.id)}/image/${stamp}.${ext}` : originalKey;
  if (chosen) {
    const bytes = await getObjectBytes(chosen).catch(() => null);
    if (!bytes) throw new AvatarError("That AI photo has expired. Choose again.");
    await putObject(imageKey, bytes, ext === "jpg" ? "image/jpeg" : `image/${ext}`);
  }
  await db.avatar.update({ where: { id: avatar.id }, data: { s3ImageKey: imageKey, s3OriginalImageKey: originalKey } });

  // Replaced files and every candidate: best effort, the DB already points at the new ones.
  const replaced = [avatar.s3ImageKey, avatar.s3OriginalImageKey]
    .filter((key): key is string => Boolean(key) && key !== imageKey && key !== originalKey);
  await Promise.all([...replaced.map((key) => deleteObject(key).catch(() => {})), deletePrefix(candidates).catch(() => {})]);
  return { avatarUrl: avatarPhotoUrl(persona.slug, { s3ImageKey: imageKey, updatedAt: new Date() }), professional: Boolean(chosen) };
}

/**
 * Saves the on-camera take from /twin/brain/voice: its cloned voice becomes the persona's own and its video is kept on
 * the persona's avatar as the AI avatar reference. Twins then speak with the voice: their old copied `voiceId` is
 * cleared (versioned), so the persona's voice applies. A previous voice / video nothing else uses is deleted.
 */
export async function savePersonaVoice(orgId: string, input: { voiceId: string; videoKey: string }) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) throw new AvatarError("Set up your twin first");
  const avatar = persona.avatar;
  const folder = avatar ? videoFolder(orgId, avatar.id) : null;
  const videoOk = folder && input.videoKey.startsWith(folder) && /^[0-9a-f-]{36}\.(webm|mp4)$/.test(input.videoKey.slice(folder.length));
  if (!avatar || !videoOk) throw new AvatarError("Unknown video");
  // The voice must be this org's, ready, and not owned by another persona.
  const voice = await db.voice.findFirst({
    where: { id: input.voiceId, orgId, status: "ready", OR: [{ persona: null }, { persona: { id: persona.id } }] },
    select: { id: true },
  });
  if (!voice) throw new AvatarError("Unknown voice");

  const previousVoiceId = persona.voiceId && persona.voiceId !== voice.id ? persona.voiceId : null;
  const twins = await db.agent.findMany({
    where: { orgId, kind: "TWIN", personaId: persona.id },
    select: { id: true, slug: true, version: true, data: true },
  });
  // Twins that carry their own copy of a voice (written by the earlier setup) would override the persona's.
  const copied = twins.filter((twin) => typeof asRecord(twin.data).voiceId === "string");
  await db.$transaction([
    db.avatar.update({ where: { id: avatar.id }, data: { s3VideoKey: input.videoKey } }),
    db.persona.update({ where: { id: persona.id }, data: { voiceId: voice.id } }),
    ...copied.flatMap((twin) => {
      const { voiceId: _dropped, ...data } = asRecord(twin.data);
      void _dropped;
      return [
        db.specVersion.create({ data: { entityType: "agents", entitySlug: twin.slug, version: twin.version, data: json(twin.data), orgId } }),
        db.agent.update({ where: { id: twin.id }, data: { version: twin.version + 1, data: json(data) } }),
      ];
    }),
  ]);
  if (avatar.s3VideoKey && avatar.s3VideoKey !== input.videoKey) await deleteObject(avatar.s3VideoKey).catch(() => {});
  if (previousVoiceId) await removeUnusedVoice(orgId, previousVoiceId);
  return { twins: copied.length };
}

/** Deletes a voice no persona owns and no agent names (e.g. the one a re-recording replaced). */
async function removeUnusedVoice(orgId: string, voiceId: string) {
  const [owner, agents] = await Promise.all([
    db.persona.findFirst({ where: { voiceId }, select: { id: true } }),
    db.agent.count({ where: { orgId, data: { path: ["voiceId"], equals: voiceId } } }),
  ]);
  if (owner || agents) return;
  await deletePrefix(`${voicePrefix(orgId, voiceId)}/`).catch(() => {});
  await db.voice.deleteMany({ where: { id: voiceId, orgId } });
}

/** The S3 key of the persona's photo (for the same-site avatar route). */
export async function avatarImageKey(orgId: string, personaSlug: string) {
  const persona = await db.persona.findFirst({ where: { orgId, slug: personaSlug }, select: { avatar: { select: { s3ImageKey: true } } } });
  return persona?.avatar?.s3ImageKey ?? null;
}
