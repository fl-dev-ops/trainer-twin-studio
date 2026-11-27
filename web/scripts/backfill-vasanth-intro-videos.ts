/**
 * Copies Vasanth's legacy intros into the intro upload setting, retaining the original keys for rollback.
 * From web/, use the target app's DATABASE_URL and S3 environment:
 *   dir=$(mktemp -d ./.intro-backfill.XXXXXX); trap 'rm -rf "$dir"' EXIT
 *   bun build scripts/backfill-vasanth-intro-videos.ts --target=node --packages=external --outfile="$dir/backfill.mjs"
 *   node --env-file=.env "$dir/backfill.mjs"
 * Review the dry run before adding --apply. Deploy the intro uploader before applying in production.
 */
import { randomUUID } from "node:crypto";
import { beforeSettings, INTRO_VIDEO_MAX_BYTES } from "@/lib/context-upload";
import { db, withLock } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { copyObject, deleteObject, isUploadedMp4, orgPrefix, roleplayIntroKey } from "@/lib/s3";
import { ownershipLock } from "@/lib/skill-ownership";

const apply = process.argv.includes("--apply");
const orgSlug = "careerwithvasanth";
const select = {
  id: true, slug: true, data: true,
  _count: { select: { personas: { where: { active: true } } } },
} as const;

try {
  const { id: orgId } = await db.organization.findUniqueOrThrow({ where: { slug: orgSlug }, select: { id: true } });
  const where = { orgId, kind: "ROLEPLAY" as const, archivedAt: null };
  const prefixes = new Set([`trainertwin/kb/${orgId}`, orgPrefix(orgId)]);
  const candidates: { id: string; slug: string; source: string }[] = [];

  function legacyIntro(row: { slug: string; data: unknown; _count: { personas: number } }) {
    const data = row.data as { introVideo?: unknown; introVideoUpload?: unknown } | null;
    if (data?.introVideoUpload !== undefined || beforeSettings(data).introVideoUrl !== undefined || row._count.personas !== 1) return;
    const source = data?.introVideo;
    if (typeof source !== "string" || !source) return;
    for (const prefix of prefixes) {
      const folder = `${prefix}/scenario-intros/${row.slug}/`;
      if (source.startsWith(folder) && /^intro-[a-f0-9]+\.mp4$/i.test(source.slice(folder.length))) return source;
    }
    throw new Error(`${row.slug}: unexpected legacy intro location`);
  }

  console.log(`${orgSlug}: ${apply ? "apply" : "dry run"} on ${new URL(process.env.DATABASE_URL ?? "postgresql://localhost").hostname}`);
  for (const row of await db.agent.findMany({ where, select, orderBy: { slug: "asc" } })) {
    const source = legacyIntro(row);
    if (!source) {
      console.log(`${row.slug}: unchanged`);
      continue;
    }
    if (!await isUploadedMp4(source, INTRO_VIDEO_MAX_BYTES)) throw new Error(`${row.slug}: legacy MP4 could not be verified`);
    console.log(`${row.slug}: legacy clip verified`);
    candidates.push({ id: row.id, slug: row.slug, source });
  }
  if (apply) for (const row of candidates) {
    const uploadId = randomUUID();
    const key = roleplayIntroKey(orgId, row.id, uploadId);
    await copyObject(row.source, key);
    if (!await isUploadedMp4(key, INTRO_VIDEO_MAX_BYTES)) {
      await deleteObject(key);
      throw new Error(`${row.slug}: copied MP4 could not be verified`);
    }
    const saved = await withLock([ownershipLock(orgId), `agent:${row.slug}`], async (tx) => {
      const current = await tx.agent.findFirst({ where: { ...where, id: row.id }, select });
      if (!current || legacyIntro(current) !== row.source) return false;
      const data = current.data as Prisma.JsonObject;
      // Keep the original key until older web deployments can no longer be rolled back to.
      await tx.agent.update({ where: { id: row.id }, data: { data: { ...data, introVideoUpload: uploadId } } });
      return true;
    });
    if (!saved) await deleteObject(key);
    console.log(`${row.slug}: ${saved ? "migrated" : "changed during migration; unchanged"}`);
  }
  console.log(`${candidates.length} eligible clips`);
} finally {
  await db.$disconnect();
}
