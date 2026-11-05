/**
 * Moves uploads still stored in Postgres (ContextDocument.content) to S3 (plans/uploads-to-s3.md): writes each to its
 * key, sets s3Key, clears content. Idempotent; readers handle both forms meanwhile. Dry run unless --apply.
 *   DATABASE_URL=... bun scripts/backfill-uploads-s3.ts [--apply]
 */
import { db } from "@/lib/db";
import { getObjectBytes, putObject } from "@/lib/s3";
import { uploadKey } from "@/lib/uploads";

const apply = process.argv.includes("--apply");
const rows = await db.contextDocument.findMany({
  where: { s3Key: null, content: { not: null } },
  select: { id: true, orgId: true, name: true, mimeType: true, size: true },
});
console.log(`${rows.length} uploads to move${apply ? "" : " (dry run; pass --apply)"}`);
let moved = 0;
for (const row of rows) {
  const key = uploadKey(row.orgId ?? "no-org", row.id, row.name);
  if (!apply) {
    console.log(`  ${row.id} ${row.name} (${row.size} bytes) -> ${key}`);
    continue;
  }
  const doc = await db.contextDocument.findUniqueOrThrow({ where: { id: row.id }, select: { content: true } });
  const bytes = new Uint8Array(doc.content!);
  await putObject(key, bytes, row.mimeType);
  const stored = await getObjectBytes(key);
  if (stored.byteLength !== bytes.byteLength) throw new Error(`${row.id}: S3 copy is ${stored.byteLength} bytes, expected ${bytes.byteLength}`);
  // Only after the copy is verified: the bytes leave Postgres.
  await db.contextDocument.update({ where: { id: row.id }, data: { s3Key: key, content: null } });
  moved++;
}
console.log(apply ? `moved ${moved}` : "done");
await db.$disconnect();
