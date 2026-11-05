import { z } from "zod";
import { getTrainerOrg } from "@/lib/org";
import { uploader } from "@/lib/upload-access";
import { startUpload, UPLOAD_PURPOSES, UploadError } from "@/lib/uploads";

export const runtime = "nodejs";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(120).default(""),
  size: z.number().int().positive(),
  purpose: z.enum(UPLOAD_PURPOSES),
  /** A learner's role-play invite or twin code, before they join the org. */
  shareCode: z.string().trim().max(200).optional(),
}).strict();

/**
 * Starts an upload (lib/uploads.ts): a pending record and a presigned PUT; the browser sends the file straight to S3,
 * then calls /api/uploads/<id>/complete. Copilot files belong to the studio member's org of this tab.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid upload" }, { status: 400 });
  const input = parsed.data;
  const who = input.purpose === "copilot"
    ? await getTrainerOrg().then((org) => (org ? { org, user: org.user } : null))
    : await uploader(input.shareCode);
  if (!who) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const started = await startUpload({ orgId: who.org.id, userId: who.user.id, name: input.name, mimeType: input.mimeType, size: input.size, purpose: input.purpose });
    return Response.json(started, { status: 201 });
  } catch (error) {
    if (error instanceof UploadError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
