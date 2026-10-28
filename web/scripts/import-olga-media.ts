/**
 * Fills an org's knowledge with a trainer's videos from our side: each video is streamed (no local copy) to the
 * original slot of a knowledge document, and the transcript we already have becomes its ingested version
 * (content.md), the same two copies an upload makes. Ingestion stays paused, as for uploads.
 *
 *   bun scripts/import-olga-media.ts --org olga --kind loom|youtube --dir <transcripts dir> [--ids <file>] [--transcript-only] [--dry-run]
 *
 * --transcript-only: no video; the transcript is both the original (<slug>.md) and the ingested version. Documents
 * already stored (video or transcript) are kept.
 *
 * --dir holds one Markdown transcript per video, with front matter (id, title, date, url).
 * Loom videos are listed as uploads (externalId loom:<id>); YouTube videos get a youtube KnowledgeSource each
 * (externalId = video id, so the list shows the YouTube thumbnail and link).
 * Idempotent: a video already stored is skipped; a failed or non-video document is redone in place.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";
import { deleteObject, orgPrefix, putObject } from "@/lib/s3";

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const kind = arg("kind");
const dir = arg("dir");
const dryRun = process.argv.includes("--dry-run");
const transcriptOnly = process.argv.includes("--transcript-only");
const ext = transcriptOnly ? "md" : "mp4";
if ((kind !== "loom" && kind !== "youtube") || !dir || !arg("org")) throw new Error("--org, --kind loom|youtube and --dir are required");
if (process.env.DATABASE_URL?.includes("ep-mute-pine") && process.env.S3_BASE_PREFIX !== "trainertwin/kb") throw new Error("prod DB needs S3_BASE_PREFIX=trainertwin/kb");
const bucket = process.env.S3_BUCKET;
if (!bucket) throw new Error("S3_BUCKET is not set");
// Loom (HLS) and YouTube (DASH) are streamed by their own scripts: same contract, <url> <s3://bucket/key>.
// shortcut: the Loom stream script failed on some Looms ("--Frag" temp file); Olga's Looms went in --transcript-only. Fix before streaming Looms again.
const streamScript = join(import.meta.dir, kind === "loom" ? "stream-loom-to-s3.sh" : "stream-video-to-s3.sh");

type Video = { id: string; title: string; date: string | null; url: string; markdown: string };

/** Front-matter fields we need (flat `key: value` lines; values may be quoted). */
function frontMatter(text: string) {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const field = (key: string) => {
    const raw = block.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1]?.trim();
    if (!raw) return null;
    return raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  };
  return { id: field("id"), title: field("title"), date: field("date"), url: field("url") };
}

async function videos(): Promise<Video[]> {
  const only = arg("ids") ? new Set((await readFile(arg("ids")!, "utf8")).split(/\s+/).filter(Boolean)) : null;
  const list: Video[] = [];
  for (const file of (await readdir(dir!)).filter((name) => name.endsWith(".md")).sort()) {
    const markdown = await readFile(join(dir!, file), "utf8");
    const meta = frontMatter(markdown);
    if (!meta.id || !meta.url) throw new Error(`${file}: front matter needs id and url`);
    if (only && !only.has(meta.id)) continue;
    list.push({ id: meta.id, title: meta.title || meta.id, date: meta.date, url: meta.url, markdown });
  }
  if (only && list.length !== only.size) throw new Error(`--ids lists ${only.size} videos, ${list.length} have a transcript in --dir`);
  return list;
}

const safeName = (title: string) => title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "video";

async function main() {
  const org = await db.organization.findFirstOrThrow({ where: { OR: [{ id: arg("org") }, { slug: arg("org") }] }, select: { id: true, slug: true } });
  const kb = await getOrCreateOrgKnowledgeBase(org.id);
  const list = await videos();
  console.log(`${list.length} ${kind} videos for ${org.slug}${dryRun ? " [dry run]" : ""}`);
  let done = 0, skipped = 0, failed = 0;

  for (const [n, video] of list.entries()) {
    const label = `[${n + 1}/${list.length}] ${video.id} ${video.title.slice(0, 60)}`;
    const watchUrl = kind === "youtube" ? `https://www.youtube.com/watch?v=${video.id}` : video.url;
    const source = kind === "youtube"
      ? await db.knowledgeSource.upsert({
          where: { identityKey: `${kb.id}:youtube:${video.id}` },
          create: { orgId: org.id, kbId: kb.id, connector: "youtube", externalId: video.id, identityKey: `${kb.id}:youtube:${video.id}`, sourceUrl: watchUrl, status: "active" },
          update: {},
        })
      : null;
    const externalId = kind === "youtube" ? video.id : `loom:${video.id}`;
    const existing = await db.knowledgeDocument.findFirst({ where: { kbId: kb.id, externalId } });
    if (existing?.status === "uploaded" && (existing.ext === "mp4" || transcriptOnly)) {
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`${label}: would ${existing ? "redo" : "import"}`);
      continue;
    }

    let slug = existing?.slug.endsWith(`.${ext}`) ? existing.slug : `${safeName(video.title)}.${ext}`;
    for (let i = 1; await db.knowledgeDocument.findFirst({ where: { kbId: kb.id, slug, NOT: { id: existing?.id ?? "" } }, select: { id: true } }); i++) {
      slug = `${safeName(video.title)}-${i}.${ext}`;
    }
    const createdAt = video.date ? new Date(`${video.date}T00:00:00Z`) : undefined;
    const doc = existing
      ? await db.knowledgeDocument.update({ where: { id: existing.id }, data: { slug, title: video.title, ext, status: "uploading", error: null, sourceId: source?.id ?? existing.sourceId } })
      : await db.knowledgeDocument.create({
          data: { kbId: kb.id, sourceId: source?.id, externalId, slug, title: video.title, ext, size: 0, s3SourceKey: "pending", status: "uploading", ...(createdAt ? { createdAt } : {}) },
        });
    const sourceKey = `${orgPrefix(org.id)}/knowledge/files/${doc.id}/${slug}`;
    const markdownKey = `${orgPrefix(org.id)}/ingest/files/${doc.id}/content.md`;
    try {
      if (transcriptOnly) {
        await putObject(sourceKey, video.markdown, "text/markdown; charset=utf-8");
        await putObject(markdownKey, video.markdown, "text/markdown; charset=utf-8");
        await db.knowledgeDocument.update({ where: { id: doc.id }, data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey, size: Buffer.byteLength(video.markdown), status: "uploaded" } });
        done++;
        console.log(`${label}: transcript`);
        continue;
      }
      const run = spawnSync(streamScript, [video.url, `s3://${bucket}/${sourceKey}`], { encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
      if (run.status !== 0) throw new Error(`video stream failed: ${(run.stderr || "").trim().split("\n").slice(-2).join(" | ").slice(0, 400)}`);
      const head = spawnSync("aws", ["s3api", "head-object", "--bucket", bucket!, "--key", sourceKey, "--query", "ContentLength", "--output", "text"], { encoding: "utf8", env: process.env });
      const size = Number(head.stdout.trim());
      if (head.status !== 0 || !(size > 100_000)) throw new Error(`stored video looks empty (${head.stdout.trim() || head.stderr.trim()})`);
      await putObject(markdownKey, video.markdown, "text/markdown; charset=utf-8");
      // A redone document may have had another original (e.g. the transcript as an upload): drop it.
      if (existing && existing.s3SourceKey !== sourceKey && existing.s3SourceKey !== "pending" && existing.s3SourceKey !== markdownKey) await deleteObject(existing.s3SourceKey).catch(() => {});
      await db.knowledgeDocument.update({ where: { id: doc.id }, data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey, size: Math.min(size, 2_147_483_647), status: "uploaded" } });
      done++;
      console.log(`${label}: ${(size / 1e6).toFixed(1)} MB`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      await db.knowledgeDocument.update({ where: { id: doc.id }, data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey, status: "failed", error: message.slice(0, 1000) } });
      console.log(`${label}: FAILED ${message}`);
    }
  }
  console.log(`done: ${done} imported, ${skipped} already there, ${failed} failed`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
