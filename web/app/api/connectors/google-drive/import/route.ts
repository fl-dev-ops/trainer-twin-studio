import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";
import { assertDriveOrigin, downloadDriveFile, driveAccess, DriveError, driveFileId, DRIVE_TOKEN_COOKIE } from "@/lib/google-drive";

export const runtime = "nodejs";
export const maxDuration = 120;
const schema = z.object({ fileId: driveFileId }).strict();

/** One file per request keeps partial failures retryable; no Drive crawl, SQS job or embeddings. */
export async function POST(request: NextRequest) {
  const actor = await getTrainerOrg();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    assertDriveOrigin(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Choose a valid Google Drive file." }, { status: 400 });
    const { accessToken } = driveAccess(request.cookies.get(DRIVE_TOKEN_COOKIE)?.value, actor);
    const fileId = parsed.data.fileId;
    // Check access even for repeat imports. Never trust the browser's file metadata or URLs.
    const file = await downloadDriveFile(fileId, accessToken);
    const externalId = `google-drive:${fileId}`;
    const existing = await db.knowledgeDocument.findFirst({
      where: { kb: { orgId: actor.id }, externalId, status: "uploaded" }, select: { id: true },
    });
    if (existing) return NextResponse.json({ ok: true, alreadyImported: true, documentId: existing.id });
    const doc = await OrganizationKnowledgeService.uploadDocument(actor.id, file);
    await db.knowledgeDocument.update({ where: { id: doc.id }, data: { externalId } });
    return NextResponse.json({ ok: true, documentId: doc.id, status: doc.status }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Google Drive import failed." }, { status: error instanceof DriveError ? error.status : 500 });
  }
}
