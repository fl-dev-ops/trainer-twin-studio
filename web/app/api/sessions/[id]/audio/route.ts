import { NextResponse } from "next/server";
import { errorResponse, refusals } from "@/lib/errors";
import { db } from "@/lib/db";
import { resolveSessionUser, visibleSessions } from "@/lib/session-user";
import { orgOwnKey, presignedGetUrl } from "@/lib/s3";

/** Recording access is limited to its learner or a studio member (admin or team) in the same org. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return errorResponse(refusals.signedOut());
  const { id } = await params;
  // Someone without access gets the same answer as for a session that doesn't exist.
  const visible = await visibleSessions(org.id, user.id);
  if (!visible) return errorResponse(refusals.notFound());
  const session = await db.interviewSession.findFirst({
    where: { id, ...visible },
    select: { s3AudioKey: true, userId: true },
  });
  // Only a file under this call's org is signed (practice rule 27).
  const key = orgOwnKey(org.id, session?.s3AudioKey);
  if (!key) return errorResponse(refusals.notFound());
  return NextResponse.redirect(await presignedGetUrl(key, 3600));
}
