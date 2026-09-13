import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const org = await getSessionOrg();
  if (!org) return new Response("Unauthorized", { status: 401 });
  const { user } = await resolveSessionUser().catch(() => ({ user: null }));
  if (!user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return new Response("Missing required sessionId parameter", { status: 400 });
  }

  // Authorize that the session belongs to this user/org and has this document attached
  const sessionDoc = await db.interviewSessionDocument.findFirst({
    where: {
      sessionId,
      documentId: id,
      session: {
        orgId: org.id,
        userId: user.id,
      },
    },
    include: {
      document: {
        select: { name: true, mimeType: true, content: true },
      },
    },
  });

  const doc = sessionDoc?.document;
  if (!doc) return new Response("Not found", { status: 404 });

  return new Response(doc.content, {
    headers: {
      "Content-Type": doc.mimeType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(doc.name)}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
