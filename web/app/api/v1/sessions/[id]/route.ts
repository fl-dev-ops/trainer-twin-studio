import { errorResponse, refusals } from "@/lib/errors";
import { db } from "@/lib/db";
import { requireExternalApi, apiRoute } from "@/lib/external-api";
import { orgOwnKey, orgPrefix, presignedGetUrl } from "@/lib/s3";

type Params = { params: Promise<{ id: string }> };

/** Read-only in the public API (no DELETE): sessions are managed in the TrainerTwin app. */
async function handleGET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "sessions", "read");
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
      assignmentId: true,
      status: true,
      mode: true,
      chargesOrg: true,
      contextName: true,
      createdAt: true,
      transcript: true,
      report: true,
      reportStatus: true,
      evidence: true,
      videoEgressId: true,
      s3AudioKey: true,
      startedAt: true,
      endedAt: true,
    },
  });
  if (!session) return errorResponse(refusals.notFound());
  // Presigned download URL for the recording (1 hour); null when no audio exists.
  const audioKey = orgOwnKey(api.org.id, session.s3AudioKey);
  const audioUrl = audioKey ? await presignedGetUrl(audioKey, 3600).catch((error) => {
    console.error("Failed to presign audio recording:", error);
    return null;
  }) : null;
  const internal = session as { s3AudioKey?: string | null; videoEgressId?: string | null };
  // Video recording: evidence carries the explicit S3 key; otherwise the standard
  // composite-egress recording path is used when a video egress was started.
  const evidence = session.evidence && typeof session.evidence === "object" ? (session.evidence as Record<string, unknown>) : {};
  const videoKey =
    orgOwnKey(api.org.id, evidence.videoS3Key)
      ?? (internal.videoEgressId
        ? `${orgPrefix(api.org.id)}/recordings/${id}/video.mp4`
        : null);
  const videoUrl = videoKey ? await presignedGetUrl(videoKey, 3600).catch((error) => {
    console.error("Failed to presign video recording:", error);
    return null;
  }) : null;
  delete internal.s3AudioKey;
  delete internal.videoEgressId;
  return Response.json({ session: { ...session, audioUrl, videoUrl } });
}

export const GET = apiRoute(handleGET);
