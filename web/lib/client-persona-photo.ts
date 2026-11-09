import { orgPrefix } from "@/lib/s3";

/** Photos uploaded for client personas made from scratch (presets keep their static photos). */

export const PERSONA_PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const MAX_PERSONA_PHOTO_BYTES = 5 * 1024 * 1024;

const PHOTO_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

export const isPersonaPhotoName = (name: string) => PHOTO_NAME.test(name);

export function personaPhotoKey(orgId: string, name: string) {
  return `${orgPrefix(orgId)}/persona-photos/${name}`;
}

export function personaPhotoUrl(orgId: string, name: string) {
  return `/api/client-persona-photos/${orgId}/${name}`;
}
