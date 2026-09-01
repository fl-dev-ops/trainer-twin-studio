import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "sessions", "read");
  if (isApiError(api)) return api;
  const { id } = await params;
  const session = await db.interviewSession.findFirst({
    where: { id, orgId: api.org.id, deletedAt: null },
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

export async function DELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "sessions", "write");
  if (isApiError(api)) return api;
  const { id } = await params;
  const updated = await db.interviewSession.updateMany({
    where: { id, orgId: api.org.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (!updated.count) return Response.json({ error: "Session not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
