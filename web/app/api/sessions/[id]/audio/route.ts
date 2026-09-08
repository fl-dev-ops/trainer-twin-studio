import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";
import { presignedGetUrl } from "@/lib/s3";

/** Recording access is limited to its learner or an owner/admin in the same org. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const session = await db.interviewSession.findFirst({
    where: { id, orgId: org.id },
    select: { s3AudioKey: true, userId: true },
  });
  if (!session?.s3AudioKey) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (session.userId !== user.id) {
    const trainer = await db.member.findFirst({
      where: { organizationId: org.id, userId: user.id },
      select: { role: true },
    });
    if (!trainer?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }
  return NextResponse.redirect(await presignedGetUrl(session.s3AudioKey, 3600));
}
