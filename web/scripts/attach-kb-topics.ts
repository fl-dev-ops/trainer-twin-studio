/**
 * Attach canonical topic slugs to knowledge-base chunks (thin slice of the
 * topic-grounding plan). Seeds the canonical Topic rows, then classifies each
 * chunk in a KB to its nearest topic (by embedding cosine, reusing the chunk's
 * stored embedding) and writes `topic` into the chunk metadata.
 *
 *   bun scripts/attach-kb-topics.ts <kbSlug>            # default: acme-knowledge
 *
 * Canonical topics + descriptions match the target scenario's stage tags
 * (project-experience-deep-dive: resume / architecture / project-depth).
 */
import { db } from "@/lib/db";
import { embedTexts } from "@/lib/knowledge";
import { MainCollectionService } from "@/lib/main-collection";
import type { Where } from "chromadb";

const KB_SLUG = process.argv[2] ?? "acme-knowledge";

const TOPICS: { slug: string; description: string }[] = [
  { slug: "resume", description: "The candidate's résumé, work history, roles, employers, and stated professional experience." },
  { slug: "architecture", description: "System architecture and design: components, services, data flow, scaling, reliability, and technical structure." },
  { slug: "project-depth", description: "Deep project details: technical decisions, trade-offs, implementation approach, challenges, and measurable outcomes." },
];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function main() {
  const kb = await db.knowledgeBase.findFirst({
    where: { slug: KB_SLUG },
    select: { id: true, orgId: true, slug: true },
  });
  if (!kb?.orgId) throw new Error(`Knowledge base "${KB_SLUG}" not found`);
  console.log(`KB ${kb.slug} (${kb.id}) org ${kb.orgId}`);

  // 1. Seed canonical topics (idempotent).
  for (const t of TOPICS) {
    await db.topic.upsert({
      where: { slug: t.slug },
      update: { description: t.description, status: "approved" },
      create: { slug: t.slug, description: t.description, status: "approved" },
    });
  }
  const topicEmbeddings = await embedTexts(TOPICS.map((t) => `${t.slug}: ${t.description}`));

  // 2. Page through the KB's chunks, classify, and write topic metadata back.
  const collection = await MainCollectionService.getCollection(kb.orgId);
  const where = { $and: [{ type: "knowledge" }, { kbId: kb.id }] } as Where;
  const counts: Record<string, number> = {};
  let total = 0;

  for (let offset = 0; ; offset += 300) {
    const page = await collection.get({
      where,
      limit: 300,
      offset,
      include: ["documents", "metadatas", "embeddings"],
    });
    const ids = page.ids ?? [];
    if (!ids.length) break;
    const docs = page.documents ?? [];
    const metas = (page.metadatas ?? []) as Record<string, unknown>[];
    const embs = (page.embeddings ?? []) as number[][];

    const updateMetas: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i++) {
      const emb = embs[i] ?? (await embedTexts([String(docs[i] ?? "")]))[0];
      let best = 0, bestScore = -Infinity;
      for (let t = 0; t < topicEmbeddings.length; t++) {
        const s = cosine(emb, topicEmbeddings[t]);
        if (s > bestScore) { bestScore = s; best = t; }
      }
      const topic = TOPICS[best].slug;
      counts[topic] = (counts[topic] ?? 0) + 1;
      updateMetas.push({ ...metas[i], topic });
    }

    await collection.update({ ids, metadatas: updateMetas });
    total += ids.length;
    if (ids.length < 300) break;
  }

  console.log(`Attached topics to ${total} chunks:`, counts);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
