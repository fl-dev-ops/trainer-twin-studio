import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";
import { orgPrefix, presignedGetUrl } from "@/lib/s3";

type Params = { params: Promise<{ id: string }> };

/** Read-only in the public API (no DELETE): sessions are managed in the TrainerTwin app. */
export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "sessions", "read");
  if (isApiError(api)) return api;
  const { id } = await params;
  const session = await db.interviewSession.findFirst({
    // The public API serves role plays only: a twin session answers like an unknown one.
    where: { id, orgId: api.org.id, deletedAt: null, agent: { kind: "ROLEPLAY" } },
    select: {
      id: true,
      userId: true,
      personaSlug: true,
      personaVersion: true,
      agentSlug: true,
      agentVersion: true,
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
