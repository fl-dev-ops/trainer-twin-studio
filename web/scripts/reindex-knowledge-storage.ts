import { db } from "../lib/db";
import { ingestDoc, knowledgeCollectionName, removeCollection } from "../lib/knowledge";
import { deletePrefix, getObjectBytes, getObjectText, kbPrefix, putObject } from "../lib/s3";

const cleanupLegacy = process.argv.includes("--cleanup-legacy");
const replaceCollections = process.argv.includes("--replace-collections");
const bases = await db.knowledgeBase.findMany({ include: { documents: true } });
let indexed = 0;
for (const base of bases) {
  if (replaceCollections) await removeCollection(knowledgeCollectionName(base.id));
  const legacyPrefixes = new Set<string>();
  for (const document of base.documents) {
    if (!replaceCollections && document.status === "indexed" && document.s3SourceKey.startsWith(kbPrefix(base.id))) continue;
    const markdown = await getObjectText(document.s3MarkdownKey);
    const source = await getObjectBytes(document.s3SourceKey);
    const marker = `/${document.id}/`;
    if (document.s3SourceKey.includes(marker)) legacyPrefixes.add(document.s3SourceKey.split(marker)[0]);
    const sourceKey = `${kbPrefix(base.id, document.id)}/source-${document.slug}`;
    const markdownKey = `${kbPrefix(base.id, document.id)}/content.md`;
    await Promise.all([
      putObject(sourceKey, source, "application/octet-stream"),
      putObject(markdownKey, markdown, "text/markdown; charset=utf-8"),
    ]);
    await ingestDoc(base.id, document.id, document.slug, markdown, base.orgId ?? undefined, document.title || document.slug);
    await db.knowledgeDocument.update({
      where: { id: document.id },
      data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey, status: "indexed", error: null, indexedAt: new Date() },
    });
    indexed++;
  }
  if (cleanupLegacy) {
    await removeCollection(`kb_${base.slug}`);
    for (const prefix of legacyPrefixes) {
      if (prefix !== kbPrefix(base.id)) await deletePrefix(prefix);
    }
  }
}
console.log(`done: ${indexed} knowledge documents moved and indexed`);
