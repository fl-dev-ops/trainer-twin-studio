import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { activateSession } from "@/lib/interview-sessions";
import { saveUpload } from "@/lib/specs";

export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.COPILOT_SERVICE_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Bench-only equivalent of /talk's upload then session activation flow. */
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  if (!orgId) return Response.json({ error: "Organization is required" }, { status: 400 });

  const form = await request.formData();
  const file = form.get("file");
  const agentSlug = form.get("agentSlug");
  if (!(file instanceof File) || typeof agentSlug !== "string" || !agentSlug.trim()) {
    return Response.json({ error: "file and agentSlug are required" }, { status: 400 });
  }

  const member = await db.member.findFirst({
    where: { organizationId: orgId },
    select: { userId: true, user: { select: { name: true } } },
  });
  if (!member) return Response.json({ error: "Organization has no learner member" }, { status: 404 });

  try {
    const document = await saveUpload(
      orgId,
      file.name,
      file.type || "application/octet-stream",
      Buffer.from(await file.arrayBuffer()),
      member.userId,
    );
    const activated = await activateSession({
      orgId,
      userId: member.userId,
      agentSlug: agentSlug.trim(),
      contextIds: [document.id],
    });
    if (!activated) return Response.json({ error: "Could not activate session" }, { status: 409 });

    const [session, storedDocument] = await Promise.all([
      db.interviewSession.findUniqueOrThrow({
        where: { id: activated.id },
        select: {
          id: true,
          agentSlug: true,
          personaSlug: true,
          domainSlug: true,
          status: true,
        },
      }),
      db.contextDocument.findUniqueOrThrow({
        where: { id: document.id },
        select: { extractedText: true },
      }),
    ]);
    return Response.json({
      document: {
        id: document.id,
        name: document.name,
        kind: document.kind,
        text: (storedDocument.extractedText ?? "").slice(0, 50_000),
      },
      session: { ...session, learnerName: member.user.name },
    }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Session preparation failed" },
      { status: 400 },
    );
  }
}
