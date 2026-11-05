import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { completeUpload, UploadError } from "@/lib/uploads";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Finishes an upload after the browser's PUT: only by the person who started it (lib/uploads.ts completeUpload). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const doc = await db.contextDocument.findFirst({ where: { id, ownerUserId: session.user.id }, select: { orgId: true } });
  if (!doc?.orgId) return Response.json({ error: "Upload not found" }, { status: 404 });
  try {
    const saved = await completeUpload({ id, orgId: doc.orgId, userId: session.user.id });
    return Response.json({ ok: true, id: saved.id, name: saved.name, kind: saved.kind, size: saved.size, manifest: saved.manifest });
  } catch (error) {
    if (error instanceof UploadError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
