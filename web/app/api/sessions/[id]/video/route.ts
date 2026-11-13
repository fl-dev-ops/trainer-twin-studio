import { NextResponse } from "next/server";
import { errorResponse, refusals } from "@/lib/errors";
import { db } from "@/lib/db";
import { resolveSessionUser, visibleSessions } from "@/lib/session-user";
import { orgOwnKey, orgPrefix, presignedGetUrl } from "@/lib/s3";

/** Video recording access is limited to its learner or a studio member (admin or team) in the same org. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return errorResponse(refusals.signedOut());
  const { id } = await params;
  // Someone without access gets the same answer as for a session that doesn't exist.
  const visible = await visibleSessions(org.id, user.id);
  if (!visible) return errorResponse(refusals.notFound());
  const session = await db.interviewSession.findFirst({
    where: { id, ...visible },
    select: { userId: true, evidence: true },
  });
  if (!session) return errorResponse(refusals.notFound());


  const evidence =
    session.evidence && typeof session.evidence === "object"
      ? (session.evidence as Record<string, unknown>)
      : {};

  const videoKey = orgOwnKey(org.id, evidence.videoS3Key) ?? `${orgPrefix(org.id)}/recordings/${id}/video.mp4`;

  try {
    const signedUrl = await presignedGetUrl(videoKey, 3600);
    return NextResponse.redirect(signedUrl);
  } catch (error) {
    console.error("Failed to generate presigned video URL:", error);
    return NextResponse.json({ error: "Failed to generate video stream" }, { status: 500 });
  }
}
