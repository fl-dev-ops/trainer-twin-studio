/**
 * Adds Markdown files to an org's knowledge as plain uploads, the same two copies an upload makes (original and
 * ingested content.md). Ingestion stays paused, as for import-olga-media.ts. Idempotent: a file whose title is
 * already in the knowledge base is skipped; nothing is changed or deleted.
 *
 *   bun scripts/import-knowledge-files.ts --org olga [--dry-run] <file.md> [...]
 *
 * Title: front-matter `title`, else the file name without its date prefix.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { db } from "@/lib/db";
import { getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";
import { orgPrefix, putObject } from "@/lib/s3";

const orgArg = process.argv[process.argv.indexOf("--org") + 1];
const dryRun = process.argv.includes("--dry-run");
const files = process.argv.slice(2).filter((arg, i, all) => arg.endsWith(".md") && all[i - 1] !== "--org");
if (!process.argv.includes("--org") || !files.length) throw new Error("--org and at least one .md file are required");
if (process.env.DATABASE_URL?.includes("ep-mute-pine") && process.env.S3_BASE_PREFIX !== "prod/trainertwin/kb") throw new Error("prod DB needs S3_BASE_PREFIX=prod/trainertwin/kb");

const safeName = (title: string) => title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "document";
function titleOf(file: string, markdown: string) {
  const fromFrontMatter = markdown.match(/^---\n[\s\S]*?^title: (.*)$[\s\S]*?\n---/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  return fromFrontMatter || basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-+/g, " ").trim();
}

const org = await db.organization.findFirstOrThrow({ where: { OR: [{ id: orgArg }, { slug: orgArg }] }, select: { id: true, slug: true } });
const kb = await getOrCreateOrgKnowledgeBase(org.id);
let done = 0, skipped = 0;
for (const file of files) {
  const markdown = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  const title = titleOf(file, markdown);
  if (await db.knowledgeDocument.findFirst({ where: { kbId: kb.id, title }, select: { id: true } })) {
    skipped++;
    console.log(`skip (already there): ${title}`);
    continue;
  }
  if (dryRun) {
    console.log(`would import: ${title} (${markdown.split(/\s+/).length} words)`);
    continue;
  }
  let slug = `${safeName(title)}.md`;
  for (let i = 1; await db.knowledgeDocument.findFirst({ where: { kbId: kb.id, slug }, select: { id: true } }); i++) slug = `${safeName(title)}-${i}.md`;
  const doc = await db.knowledgeDocument.create({ data: { kbId: kb.id, slug, title, ext: "md", size: 0, s3SourceKey: "pending", status: "uploading" } });
  const sourceKey = `${orgPrefix(org.id)}/knowledge/files/${doc.id}/${slug}`;
  const markdownKey = `${orgPrefix(org.id)}/ingest/files/${doc.id}/content.md`;
  await putObject(sourceKey, markdown, "text/markdown; charset=utf-8");
  await putObject(markdownKey, markdown, "text/markdown; charset=utf-8");
  await db.knowledgeDocument.update({ where: { id: doc.id }, data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey, size: Buffer.byteLength(markdown), status: "uploaded" } });
  done++;
  console.log(`imported: ${title}`);
}
console.log(`done: ${done} imported, ${skipped} already there${dryRun ? " [dry run]" : ""}`);
await db.$disconnect();
