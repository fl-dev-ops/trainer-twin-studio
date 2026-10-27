/** Imports Vasanth's 20 interview-session transcripts (local olga/users folder) into careerwithvasanth's knowledge base. Idempotent. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";
import { buildInventory } from "../../copilot/agent/lib/ingest";

const org = (await db.organization.findUniqueOrThrow({ where: { slug: "careerwithvasanth" }, select: { id: true } })).id;
const root = "/Users/suryaumapathy/Developers/Github/foreverlearning/olga/users/vasanth/data/youtube/video";
const names = (await readdir(root)).filter((n) => n.endsWith(".md"));
const files = await Promise.all(names.map(async (n) => ({ path: n, text: await readFile(path.join(root, n), "utf8") })));
// Career talks and podcasts among the two-person recordings; everything else two-person is an interview session.
const TALKS = /Ankush|Layoffs in service|ruined his career|B\.A Graduate|Amazon-Prime|Uber Engineer|feel nervous|200% hike|Isha \||KERALA|RazorPay|Webinar|tech layoffs end|Learning @REACT on his own/i;
const byPath = new Map(files.map((f) => [f.path, f.text]));
const sessions = buildInventory(files).filter((f) => f.candidate && !TALKS.test(f.title ?? ""));
if (sessions.length !== 20) throw new Error(`expected 20 interview sessions, got ${sessions.length}`);

let added = 0;
try {
  for (const s of sessions) {
    const text = byPath.get(s.path)!;
    const meta = Bun.YAML.parse(text.slice(3, text.indexOf("\n---", 3))) as { id: string; title: string };
    const externalId = `youtube:${meta.id}`;
    if (await db.knowledgeDocument.findFirst({ where: { externalId, kb: { orgId: org } }, select: { id: true } })) continue;
    const doc = await OrganizationKnowledgeService.uploadDocument(org, new File([text], `${meta.id}.md`, { type: "text/markdown" }));
    await db.knowledgeDocument.update({ where: { id: doc.id }, data: { externalId, title: meta.title.replace(/\s+/g, " ").trim() } });
    added++;
  }
  const docs = await db.knowledgeDocument.findMany({ where: { kb: { orgId: org }, externalId: { startsWith: "youtube:" } }, select: { title: true, status: true, s3SourceKey: true, s3MarkdownKey: true } });
  console.log(`added ${added}; youtube sessions in careerwithvasanth: ${docs.length}; statuses: ${[...new Set(docs.map((d) => d.status))]}; all keys under dev folder: ${docs.every((d) => d.s3SourceKey.startsWith(`trainertwin-dev/kb/${org}/`) && d.s3MarkdownKey?.startsWith(`trainertwin-dev/kb/${org}/`))}`);
  console.log(docs.slice(0, 3).map((d) => "  " + d.title).join("\n"));
} finally {
  await db.$disconnect();
}
