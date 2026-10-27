import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { presignedGetUrl } from "@/lib/s3";
import { avatarImageKey } from "@/lib/twin/avatar";

/** The persona's avatar photo (its Avatar row's image): org members only, redirected to S3. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = await avatarImageKey(org.id, (await params).slug);
  if (!key) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const response = NextResponse.redirect(await presignedGetUrl(key, 3600));
  // The URL carries ?v=<saved at>, so a new photo is a new URL; the presigned target expires in an hour.
  response.headers.set("Cache-Control", "private, max-age=3000");
  return response;
}
