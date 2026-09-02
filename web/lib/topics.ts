// Topic discovery is best effort; assignment uses approved topics only.
import { db } from "@/lib/db";
import { createOpenRouter, generateTopicJson } from "../../ingestion-pipeline/src/openrouter";
import type { PreparedChunk, PreparedDocument } from "./chunking";
import { applySectionTopics, buildClassificationUnits, parseUnitTopicResults } from "./section-topics";
import { createTopicResolver, normalizeTopicSlug, normalizeTopicToken, parseTopicProposals, type TopicInfo } from "./topic-normalization";
import { TOPIC_DISCOVERY_SYSTEM_PROMPT, TOPIC_ASSIGNMENT_SYSTEM_PROMPT, buildTopicDiscoveryPrompt, buildTopicAssignmentPrompt } from "./topic-prompts";

const TOPIC_MODEL = process.env.TOPIC_MODEL ?? "openai/gpt-4o-mini";
const CHUNK_BATCH_SIZE = Number(process.env.TOPIC_CHUNK_BATCH_SIZE ?? 10);
const CHUNK_SAMPLE_CHARS = 1_500;
const TOPIC_EXAMPLE_LIMIT = 20;

export type { TopicInfo } from "./topic-normalization";

/** Discover new proposals without duplicating known spellings or assigning unapproved tags. */
export async function classifyDocumentTopics(markdown: string): Promise<TopicInfo[]> {
  if (!markdown.trim()) return [];
  try {
    const examples = await db.topic.findMany({
      where: { status: "approved" }, orderBy: { slug: "asc" }, take: TOPIC_EXAMPLE_LIMIT,
      select: { slug: true, description: true },
    });
    const parsed = await generateTopicJson(
      createOpenRouter(), TOPIC_MODEL, TOPIC_DISCOVERY_SYSTEM_PROMPT,
      buildTopicDiscoveryPrompt(markdown, examples),
    );
    const existing = await db.topic.findMany({
      orderBy: { slug: "asc" }, select: { slug: true, description: true, status: true },
    });
    const bySlug = new Map(existing.map((topic) => [topic.slug, topic]));
    const resolveTopic = createTopicResolver(bySlug.keys());
    const knownTokens = new Set(existing.map((topic) => normalizeTopicToken(normalizeTopicSlug(topic.slug))));
    const resolved = new Map<string, TopicInfo>();
    for (const proposal of parseTopicProposals(parsed)) {
      const token = normalizeTopicToken(proposal.slug);
      const existingSlug = resolveTopic(proposal.slug);
      let row = existingSlug ? bySlug.get(existingSlug) : undefined;
      if (!row) {
        // Ambiguous legacy spellings already exist; do not create another variant.
        if (knownTokens.has(token)) continue;
        row = await db.topic.upsert({
          where: { slug: proposal.slug }, update: {},
          create: { ...proposal, status: "proposed" },
        });
        knownTokens.add(token);
      }
      if (row.status === "approved") resolved.set(row.slug, { slug: row.slug, description: row.description });
    }
    return [...resolved.values()].slice(0, 8);
  } catch (error) {
    console.warn(`[LLM:topics] document pass skipped: ${error instanceof Error ? error.name : "UnknownError"}`);
    return [];
  }
}

/** Legacy chunk classifier; reuse the same naming rules, prompts, and validated parser. */
export async function classifyChunkTopics(chunks: string[], allowed: TopicInfo[]): Promise<string[][]> {
  if (!chunks.length || !allowed.length) return chunks.map(() => []);
  const approvedSlugs = new Set(allowed.map((topic) => topic.slug));
  const out: string[][] = [];
  for (let start = 0; start < chunks.length; start += CHUNK_BATCH_SIZE) {
    const batch = chunks.slice(start, start + CHUNK_BATCH_SIZE).map((text, offset) => ({
      index: start + offset, sectionId: String(start + offset),
      text: text.length > CHUNK_SAMPLE_CHARS ? `${text.slice(0, CHUNK_SAMPLE_CHARS)}…` : text,
    }));
    try {
      const raw = await generateTopicJson(
        createOpenRouter(), TOPIC_MODEL, TOPIC_ASSIGNMENT_SYSTEM_PROMPT,
        buildTopicAssignmentPrompt(batch, allowed),
      );
      const results = parseUnitTopicResults(raw, batch, approvedSlugs);
      out.push(...batch.map((unit) => (results.get(unit.index) ?? []).slice(0, 4)));
    } catch (error) {
      console.warn(`[LLM:topics] chunk batch ${start} skipped: ${error instanceof Error ? error.name : "UnknownError"}`);
      out.push(...batch.map(() => []));
    }
  }
  return out;
}

/** Convenience wrapper: document discovery followed by legacy chunk assignment. */
export async function classifyMarkdownChunks(markdown: string, chunks: string[]): Promise<string[][]> {
  const topics = await classifyDocumentTopics(markdown);
  return classifyChunkTopics(chunks, topics);
}

/** Resolve approved section tags once, then inherit them into prepared chunks. */
export async function classifyPreparedDocument(markdown: string, document: PreparedDocument): Promise<PreparedChunk[]> {
  const startedAt = Date.now();
  console.info(`[LLM:section-topics] start sections=${document.sections.length} chunks=${document.chunks.length}`);
  const units = buildClassificationUnits(document);
  const results = new Map<number, string[] | null>();
  try {
    // Discovery returns only candidates that already exist with approved status.
    const approved = await classifyDocumentTopics(markdown);
    if (approved.length) {
      const allowed = new Set(approved.map((topic) => topic.slug));
      for (let start = 0; start < units.length; start += CHUNK_BATCH_SIZE) {
        const batch = units.slice(start, start + CHUNK_BATCH_SIZE);
        try {
          const raw = await generateTopicJson(
            createOpenRouter(), TOPIC_MODEL, TOPIC_ASSIGNMENT_SYSTEM_PROMPT,
            buildTopicAssignmentPrompt(batch, approved),
          );
          for (const [index, topics] of parseUnitTopicResults(raw, batch, allowed)) results.set(index, topics);
        } catch (error) {
          console.warn(`[LLM:section-topics] batch=${start} failed elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
          for (const unit of batch) results.set(unit.index, null);
        }
      }
    }
  } catch (error) {
    console.warn(`[LLM:section-topics] skipped elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
  }
  const chunks = applySectionTopics(document, units, results);
  console.info(`[LLM:section-topics] complete sections=${document.sections.length} units=${units.length} elapsedMs=${Date.now() - startedAt}`);
  return chunks;
}
