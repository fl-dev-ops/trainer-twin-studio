import { db } from "@/lib/db";
import { presignedGetUrl } from "@/lib/s3";
import { ingestAuthorized } from "@/lib/scenario-ingest";

export const runtime = "nodejs";

/**
 * The org's knowledge base as the copilot's sources (plans/twin-skill-ingest.md): every document with a Markdown copy
 * (uploads keep it at <org>/ingest/files/<docId>/content.md), as a 15-minute link the copilot downloads into its sandbox.
 * Same contract as /api/internal/scenarios: Bearer SCENARIO_INGEST_SECRET + x-trainertwin-org-id.
 * Failed uploads are left out; a deleted document is gone (its skills stay, they live elsewhere).
 */
export async function GET(request: Request) {
  if (!ingestAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  if (!orgId) return Response.json({ error: "Organization is required" }, { status: 400 });

  const docs = await db.knowledgeDocument.findMany({
    where: { kb: { orgId }, s3MarkdownKey: { not: null }, status: { not: "failed" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, s3MarkdownKey: true },
  });
  const files = await Promise.all(
    docs.map(async (doc) => ({ docId: doc.id, title: doc.title, url: await presignedGetUrl(doc.s3MarkdownKey!, 900) })),
  );
  return Response.json({ files });
}
