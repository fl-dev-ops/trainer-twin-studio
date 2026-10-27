import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { personaSourcePrefix, presignedPutUrl, putObject } from "@/lib/s3";
import { TWIN_SOURCE } from "@/lib/twins";

/**
 * The trainer's avatar setup ("Voice and avatar" on Twin's brain), stored on their own persona:
 * - `data.avatarUrl`: the photo (same-site route that redirects to S3), shown as the twin's face everywhere;
 * - `data.avatar`: { imageKey, videoKey, voiceId, transcript, updatedAt }. The video (reading the passage on camera)
 *   is kept as the AI avatar reference; its audio became the cloned voice, which every twin of the persona speaks with.
 */

export const AVATAR_VIDEO_TYPES = { "video/webm": "webm", "video/mp4": "mp4" } as const;
export type AvatarVideoType = keyof typeof AVATAR_VIDEO_TYPES;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export class AvatarError extends Error {}

const personaSelect = { id: true, slug: true, name: true, version: true, data: true, isOwn: true } as const;
const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const json = (value: unknown) => value as Prisma.InputJsonValue;

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

const avatarPrefix = (orgId: string, personaId: string) => personaSourcePrefix(orgId, personaId, "avatar");

/** What the Brain card and the capture page show. */
export async function avatarState(orgId: string) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) return null;
  const data = asRecord(persona.data);
  const avatar = asRecord(data.avatar);
  const voiceId = typeof avatar.voiceId === "string" ? avatar.voiceId : null;
  const voice = voiceId ? await db.voice.findFirst({ where: { id: voiceId, orgId }, select: { name: true } }) : null;
  return {
    personaName: persona.name,
    photoUrl: typeof data.avatarUrl === "string" ? data.avatarUrl : null,
    hasReference: typeof avatar.videoKey === "string",
    voiceName: voice?.name ?? null,
    updatedAt: typeof avatar.updatedAt === "string" ? avatar.updatedAt : null,
  };
}

/** Where the browser uploads the reference video (straight to S3). */
export async function avatarVideoUpload(orgId: string, contentType: AvatarVideoType) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) throw new AvatarError("Set up your twin first");
  const key = `${avatarPrefix(orgId, persona.id)}/reference-${Date.now()}.${AVATAR_VIDEO_TYPES[contentType]}`;
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
 * Saves the photo, records the reference video and links the cloned voice: the persona's avatar fields, and the
 * voice on every twin of the persona. Versioned like other spec edits (SpecVersion keeps the previous data).
 */
export async function saveAvatar(orgId: string, input: { photo: string; videoKey: string; voiceId: string; transcript: string }) {
  const persona = await ownTwinPersona(orgId);
  if (!persona) throw new AvatarError("Set up your twin first");
  const prefix = `${avatarPrefix(orgId, persona.id)}/reference-`;
  const videoOk = input.videoKey.startsWith(prefix) && /^\d+\.(webm|mp4)$/.test(input.videoKey.slice(prefix.length));
  if (!videoOk) throw new AvatarError("Unknown video");
  const voice = await db.voice.findFirst({ where: { id: input.voiceId, orgId, status: "ready" }, select: { id: true } });
  if (!voice) throw new AvatarError("Unknown voice");
  const photo = decodePhoto(input.photo);

  const now = new Date();
  const imageKey = `${avatarPrefix(orgId, persona.id)}/photo-${now.getTime()}.jpg`;
  await putObject(imageKey, photo, "image/jpeg");

  const avatarUrl = `/api/personas/${encodeURIComponent(persona.slug)}/avatar?v=${now.getTime()}`;
  const personaData = {
    ...asRecord(persona.data),
    avatarUrl,
    avatar: { imageKey, videoKey: input.videoKey, voiceId: voice.id, transcript: input.transcript, updatedAt: now.toISOString() },
  };
  const twins = await db.agent.findMany({ where: { orgId, kind: "TWIN", personaId: persona.id }, select: { id: true, slug: true, version: true, data: true } });
  await db.$transaction([
    db.specVersion.create({ data: { entityType: "personas", entitySlug: persona.slug, version: persona.version, data: json(persona.data), orgId } }),
    db.persona.update({ where: { id: persona.id }, data: { version: persona.version + 1, data: json(personaData) } }),
    ...twins.flatMap((twin) => [
      db.specVersion.create({ data: { entityType: "agents", entitySlug: twin.slug, version: twin.version, data: json(twin.data), orgId } }),
      db.agent.update({ where: { id: twin.id }, data: { version: twin.version + 1, data: json({ ...asRecord(twin.data), voiceId: voice.id }) } }),
    ]),
  ]);
  return { avatarUrl, twins: twins.length };
}

/** The S3 key of the persona's photo (for the same-site avatar route). */
export async function avatarImageKey(orgId: string, personaSlug: string) {
  const persona = await db.persona.findFirst({ where: { orgId, slug: personaSlug }, select: { data: true } });
  const key = asRecord(asRecord(persona?.data).avatar).imageKey;
  return typeof key === "string" ? key : null;
}
