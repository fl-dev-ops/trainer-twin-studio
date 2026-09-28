import { NextResponse } from "next/server";
import { assignmentMatchesUser } from "@/lib/assignments";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { listUploads, saveUpload } from "@/lib/specs";

export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { user } = await resolveSessionUser().catch(() => ({ user: null }));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const files = await listUploads(org.id, user.id);
  return NextResponse.json({
    files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, manifest: f.manifest, createdAt: f.createdAt })),
  });
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await db.member.findFirst({
    where: { organizationId: org.id, userId: user.id },
    select: { id: true },
  });
  if (!member) {
    const shareCode = form.get("shareCode");
    const assignment = typeof shareCode === "string" ? await db.rolePlayAssignment.findFirst({
      where: {
        shareCode,
        orgId: org.id,
        status: "pending",
        expiresAt: { gt: new Date() },
        deployment: { status: "active" },
      },
      select: {
        recipientEmail: true,
        member: { select: { userId: true } },
        sessions: { where: { status: { in: ["completed", "abandoned"] } }, select: { id: true }, take: 1 },
      },
    }) : null;
    if (!assignment || !assignmentMatchesUser(assignment, user) || assignment.sessions.length) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const doc = await saveUpload(
      org.id,
      file.name,
      file.type || "application/octet-stream",
      Buffer.from(await file.arrayBuffer()),
      user.id
    );
    return NextResponse.json({ ok: true, id: doc.id, name: doc.name, kind: doc.kind, manifest: doc.manifest });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    const status = message.includes("Unsupported") || message.includes("does not match") || message.includes("exceeds")
      ? 400
      : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
