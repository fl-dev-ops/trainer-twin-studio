import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { db } from "@/lib/db";
import { presignedGetUrl } from "@/lib/s3";

/** Streams a session recording to an authenticated trainer via presigned S3 URL. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await db.interviewSession.findUnique({
    where: { id },
    select: { s3AudioKey: true, orgId: true },
  });
  if (!session || session.orgId !== org.id || !session.s3AudioKey) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const url = await presignedGetUrl(session.s3AudioKey, 3600);
  return NextResponse.redirect(url);
}
