import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";
import { orgPrefix, presignedGetUrl } from "@/lib/s3";

/** Video recording access is limited to its learner or an owner/admin in the same org. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const session = await db.interviewSession.findFirst({
    where: { id, orgId: org.id },
    select: { s3AudioKey: true, userId: true, evidence: true },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.userId !== user.id) {
    const trainer = await db.member.findFirst({
      where: { organizationId: org.id, userId: user.id },
      select: { role: true },
    });
    if (!trainer?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const evidence =
    session.evidence && typeof session.evidence === "object"
      ? (session.evidence as Record<string, unknown>)
      : {};

  const videoKey =
    typeof evidence.videoS3Key === "string" && evidence.videoS3Key
      ? evidence.videoS3Key
      : session.s3AudioKey
        ? session.s3AudioKey.replace(/audio\.mp4$/, "video.mp4").replace(/\.wav$/, ".mp4")
        : `${orgPrefix(org.id)}/recordings/${id}/video.mp4`;

  try {
    const signedUrl = await presignedGetUrl(videoKey, 3600);
    return NextResponse.redirect(signedUrl);
  } catch (error) {
    console.error("Failed to generate presigned video URL:", error);
    return NextResponse.json({ error: "Failed to generate video stream" }, { status: 500 });
  }
}
