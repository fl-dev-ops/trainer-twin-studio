import { z } from "zod";
import {
  createWhiteboardUpload,
  validateWhiteboardObject,
  verifyParticipantRequest,
} from "@/lib/whiteboard-submission";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const uploadRequestSchema = z.object({
  roomName: z.string(),
  participantIdentity: z.string(),
  questionId: z.string(),
  revision: z.number().int().nonnegative(),
  imageSha256: z.string(),
  imageBytes: z.number().int().positive(),
});

export async function POST(request: Request) {
  const parsed = uploadRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid whiteboard upload request" }, { status: 400 });
  }
  const input = parsed.data;
  if (
    !validateWhiteboardObject(input) ||
    !(await verifyParticipantRequest(request, input.roomName, input.participantIdentity))
  ) {
    return Response.json({ error: "Whiteboard upload is not authorized" }, { status: 403 });
  }

  try {
    return Response.json(await createWhiteboardUpload(input));
  } catch (error) {
    console.error("[EXT-API:s3-whiteboard] failed to create upload URL", error);
    return Response.json({ error: "Could not prepare whiteboard upload" }, { status: 500 });
  }
}
