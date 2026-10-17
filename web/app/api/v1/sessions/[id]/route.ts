import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";
import { orgPrefix, presignedGetUrl } from "@/lib/s3";

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
      mode: true,
      contextName: true,
      createdAt: true,
      transcript: true,
      evidence: true,
      videoEgressId: true,
      s3AudioKey: true,
      startedAt: true,
      endedAt: true,
    },
  });
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  // Presigned download URL for the recording (1 hour); null when no audio exists.
  const audioUrl = session.s3AudioKey ? await presignedGetUrl(session.s3AudioKey, 3600) : null;
  const internal = session as { s3AudioKey?: string | null; videoEgressId?: string | null };
  // Video recording: evidence carries the explicit S3 key; otherwise the standard
  // composite-egress recording path is used when a video egress was started.
  const evidence = session.evidence && typeof session.evidence === "object" ? (session.evidence as Record<string, unknown>) : {};
  const videoKey =
    typeof evidence.videoS3Key === "string" && evidence.videoS3Key
      ? evidence.videoS3Key
      : internal.videoEgressId
        ? `${orgPrefix(api.org.id)}/recordings/${id}/video.mp4`
        : null;
  const videoUrl = videoKey ? await presignedGetUrl(videoKey, 3600).catch((error) => {
    console.error("Failed to presign video recording:", error);
    return null;
  }) : null;
  delete internal.s3AudioKey;
  delete internal.videoEgressId;
  return Response.json({ session: { ...session, audioUrl, videoUrl } });
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
