import { z } from "zod";
import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";
import { deletePrefix } from "@/lib/s3";

const updateSchema = z.object({ status: z.enum(["completed", "abandoned"]) }).strict();
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "sessions", "read");
  if (isApiError(api)) return api;
  const { id } = await params;
  const session = await db.interviewSession.findFirst({
    where: { id, orgId: api.org.id },
    select: {
      id: true,
      userId: true,
      personaSlug: true,
      personaVersion: true,
      agentSlug: true,
      agentVersion: true,
      domainSlug: true,
      domainVersion: true,
      status: true,
      contextName: true,
      transcript: true,
      evidence: true,
      startedAt: true,
      endedAt: true,
    },
  });
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ session });
}

export async function PATCH(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "sessions", "write");
  if (isApiError(api)) return api;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Status must be completed or abandoned" }, { status: 400 });
  const { id } = await params;
  const updated = await db.interviewSession.updateMany({
    where: { id, orgId: api.org.id },
    data: { status: parsed.data.status, endedAt: new Date() },
  });
  if (!updated.count) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({
    session: await db.interviewSession.findFirst({
      where: { id, orgId: api.org.id },
      select: { id: true, userId: true, agentSlug: true, status: true, startedAt: true, endedAt: true },
    }),
  });
}

export async function DELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "sessions", "write");
  if (isApiError(api)) return api;
  const { id } = await params;
  const session = await db.interviewSession.findFirst({
    where: { id, orgId: api.org.id },
    select: { id: true, s3AudioKey: true },
  });
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  if (session.s3AudioKey) await deletePrefix(session.s3AudioKey);
  await db.interviewSession.delete({ where: { id: session.id } });
  return new Response(null, { status: 204 });
}
