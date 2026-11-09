import { NextResponse } from "next/server";
import { presignedGetUrl } from "@/lib/s3";
import { isPersonaPhotoName, personaPhotoKey } from "@/lib/client-persona-photo";

export const runtime = "nodejs";

/**
 * Serves an uploaded persona photo by redirecting to a short-lived S3 link. Public like the preset photos in
 * /public/roleplay/avatars, because learners see the client's photo on the role-play start screen.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string; file: string }> }) {
  const { orgId, file } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId) || !isPersonaPhotoName(file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const url = await presignedGetUrl(personaPhotoKey(orgId, file), 3600);
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, max-age=600" } });
}
