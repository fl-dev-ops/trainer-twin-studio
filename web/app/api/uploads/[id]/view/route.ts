import { orgPerson } from "@/lib/org-people";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";
import { presignedGetUrl } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * Opens an upload (copilot chat chips, previews): for the person who uploaded it, or a studio member of its org. A
 * short-lived S3 link; files from before the S3 move are served by /api/documents/<id>/raw in their session.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const doc = await db.contextDocument.findFirst({
    where: { id, status: "ready", s3Key: { not: null } },
    select: { orgId: true, ownerUserId: true, s3Key: true },
  });
  if (!doc?.s3Key || !doc.orgId) return new Response("Not found", { status: 404 });
  if (doc.ownerUserId !== session.user.id) {
    const member = await orgPerson(doc.orgId, { userId: session.user.id });
    if (!member || member.disabled || !isStudioRole(member.role)) return new Response("Not found", { status: 404 });
  }
  return Response.redirect(await presignedGetUrl(doc.s3Key, 300), 302);
}
