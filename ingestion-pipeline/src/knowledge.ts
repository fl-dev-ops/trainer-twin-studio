import { ChromaClient, CloudClient, type Collection, type EmbeddingFunction } from "chromadb";
import type { Pool } from "pg";
import type { PipelineConfig } from "./config";
import { createOpenRouter, generateEmbeddings, generateTopicJson } from "./openrouter";
import { createTopicResolver, normalizeTopicSlug, normalizeTopicToken, parseTopicProposals, type TopicInfo } from "./topics/normalization";
import { TOPIC_DISCOVERY_SYSTEM_PROMPT, TOPIC_ASSIGNMENT_SYSTEM_PROMPT, buildTopicDiscoveryPrompt, buildTopicAssignmentPrompt } from "./topics/prompts";
import type { PreparedChunk, PreparedDocument } from "./chunking/markdown";
import { applySectionTopics, buildClassificationUnits, parseUnitTopicResults } from "./topics/sections";

const TOPIC_EXAMPLE_LIMIT = 20;

/** Kept byte-for-byte compatible in behavior with web/lib/knowledge.ts. */
export function chunkMarkdown(text: string, targetChars = 1200, maxChars = 2000): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  for (let paragraph of paragraphs) {
    while (paragraph.length > maxChars) {
      const cut = paragraph.lastIndexOf(". ", maxChars);
      const at = cut > maxChars / 2 ? cut + 1 : maxChars;
      chunks.push(paragraph.slice(0, at).trim());
      paragraph = paragraph.slice(at).trim();
    }
    const isHeading = /^#{1,6} /.test(paragraph);
    if (current && ((isHeading && current.length >= targetChars * 0.5) || current.length + paragraph.length > maxChars)) push();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();
  return chunks;
}

export async function embedTexts(config: PipelineConfig, texts: string[]): Promise<number[][]> {
  return generateEmbeddings(createOpenRouter(config.openRouterApiKey), config.embeddingModel, texts);
}

function chromaConnection(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 8000), ssl: parsed.protocol === "https:" };
}

function createChromaClient(config: PipelineConfig): ChromaClient {
  if (config.chromaCloud) return new CloudClient(config.chromaCloud);
  return new ChromaClient(chromaConnection(config.chromaUrl));
}

async function getCollection(config: PipelineConfig, kbSlug: string): Promise<Collection> {
  const embeddingFunction: EmbeddingFunction = {
    generate: (texts) => embedTexts(config, texts),
    generateForQueries: (texts) => embedTexts(config, texts),
    defaultSpace: () => "cosine",
    supportedSpaces: () => ["cosine"],
  };
  const configuration = config.chromaCloud
    ? { spann: { space: "cosine" as const } }
    : { hnsw: { space: "cosine" as const, ef_construction: 200, ef_search: 200, max_neighbors: 24 } };
  return createChromaClient(config).getOrCreateCollection({
    name: `kb_${kbSlug}`,
    embeddingFunction,
    configuration,
  });
}

/** Discover proposals independently; return only candidates already approved in the catalog. */
async function discoverTopics(pool: Pool, config: PipelineConfig, markdown: string): Promise<TopicInfo[]> {
  const startedAt = Date.now();
  console.info(`[LLM:topic-discovery] start model=${config.topicModel}`);
  try {
    const examples = await pool.query<TopicInfo>(
      'SELECT slug, description FROM "Topic" WHERE status = $1 ORDER BY slug LIMIT $2',
      ["approved", TOPIC_EXAMPLE_LIMIT],
    );
    console.info(`[LLM:topic-discovery] examples approved=${examples.rows.length} limit=${TOPIC_EXAMPLE_LIMIT}`);
    const raw = await generateTopicJson(
      createOpenRouter(config.openRouterApiKey), config.topicModel, TOPIC_DISCOVERY_SYSTEM_PROMPT,
      buildTopicDiscoveryPrompt(markdown, examples.rows),
    );
    const known = await pool.query<TopicInfo & { status: string }>('SELECT slug, description, status FROM "Topic" ORDER BY slug');
    const catalogApproved = known.rows.filter((topic) => topic.status === "approved").length;
    const catalogProposed = known.rows.filter((topic) => topic.status === "proposed").length;
    console.info(`[LLM:topic-discovery] catalog total=${known.rows.length} approved=${catalogApproved} proposed=${catalogProposed}`);
    const bySlug = new Map(known.rows.map((topic) => [topic.slug, topic]));
    const resolveTopic = createTopicResolver(bySlug.keys());
    const knownTokens = new Set(known.rows.map((topic) => normalizeTopicToken(normalizeTopicSlug(topic.slug))));
    const approved = new Map<string, TopicInfo>();
    const proposals = parseTopicProposals(raw);
    let createdProposals = 0;
    let unapprovedMatches = 0;
    let ambiguousMatches = 0;
    for (const proposal of proposals) {
      const token = normalizeTopicToken(proposal.slug);
      const existingSlug = resolveTopic(proposal.slug);
      const existing = existingSlug ? bySlug.get(existingSlug) : undefined;
      if (!existing) {
        if (knownTokens.has(token)) {
          ambiguousMatches++;
          continue;
        }
        const inserted = await pool.query('INSERT INTO "Topic" (id, slug, description, status, "createdAt") VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (slug) DO NOTHING', [crypto.randomUUID(), proposal.slug, proposal.description, "proposed"]);
        createdProposals += inserted.rowCount ?? 0;
        knownTokens.add(token);
      } else if (existing.status === "approved") {
        approved.set(existing.slug, { slug: existing.slug, description: existing.description });
      } else {
        unapprovedMatches++;
      }
    }
    const selected = [...approved.values()].slice(0, 8);
    console.info(`[LLM:topic-discovery] complete proposals=${proposals.length} createdProposals=${createdProposals} unapprovedMatches=${unapprovedMatches} ambiguousMatches=${ambiguousMatches} approvedMatches=${approved.size} selected=${selected.length} elapsedMs=${Date.now() - startedAt}`);
    if (!selected.length) {
      console.warn(`[LLM:topic-discovery] no-approved-candidates reason=${!catalogApproved ? "no_approved_catalog_topics" : !proposals.length ? "no_valid_proposals" : "no_approved_matches"}`);
    }
    return selected;
  } catch (error) {
    console.warn(`[LLM:topic-discovery] skipped elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
    return [];
  }
}

/** Classify complete sections once; every continuation inherits its section tags. */
export async function classifySections(pool: Pool, config: PipelineConfig, markdown: string, document: PreparedDocument): Promise<PreparedChunk[]> {
  const startedAt = Date.now();
  const units = buildClassificationUnits(document);
  const results = new Map<number, string[] | null>();
  console.info(`[LLM:section-topics] start model=${config.topicModel} sections=${document.sections.length} units=${units.length} chunks=${document.chunks.length}`);
  try {
    const approved = await discoverTopics(pool, config, markdown);
    const approvedSlugs = new Set(approved.map((topic) => topic.slug));
    if (!approvedSlugs.size || !units.length) {
      const chunks = applySectionTopics(document, units, results);
      console.warn(`[LLM:section-topics] skipped reason=${!approvedSlugs.size ? "no_approved_candidates" : "no_classification_units"} approvedCandidates=${approvedSlugs.size} chunks=${chunks.length} taggedChunks=${chunks.filter((chunk) => chunk.topics.length > 0).length} elapsedMs=${Date.now() - startedAt}`);
      return chunks;
    }
    for (let start = 0; start < units.length; start += config.topicChunkBatchSize) {
      const batch = units.slice(start, start + config.topicChunkBatchSize);
      const batchStartedAt = Date.now();
      console.info(`[LLM:section-topics] batch-start start=${start} count=${batch.length} approvedCandidates=${approvedSlugs.size}`);
      try {
        const raw = await generateTopicJson(
          createOpenRouter(config.openRouterApiKey), config.topicModel, TOPIC_ASSIGNMENT_SYSTEM_PROMPT,
          buildTopicAssignmentPrompt(batch, approved),
        );
        const parsed = parseUnitTopicResults(raw, batch, approvedSlugs);
        for (const [index, topics] of parsed) results.set(index, topics);
        const values = [...parsed.values()];
        console.info(`[LLM:section-topics] batch-complete start=${start} count=${batch.length} taggedUnits=${values.filter((topics) => topics && topics.length > 0).length} emptyUnits=${values.filter((topics) => topics?.length === 0).length} invalidUnits=${values.filter((topics) => topics === null).length} elapsedMs=${Date.now() - batchStartedAt}`);
      } catch (error) {
        for (const unit of batch) results.set(unit.index, null);
        console.warn(`[LLM:topic-classification] batch-skipped start=${start} count=${batch.length} elapsedMs=${Date.now() - batchStartedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
      }
    }
  } catch (error) {
    console.warn(`[LLM:topic-classification] skipped elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
  }
  const chunks = applySectionTopics(document, units, results);
  const taggedChunks = chunks.filter((chunk) => chunk.topics.length > 0).length;
  console.info(`[LLM:section-topics] complete chunks=${chunks.length} taggedChunks=${taggedChunks} untaggedChunks=${chunks.length - taggedChunks} failedUnits=${units.filter((unit) => !results.get(unit.index)).length} elapsedMs=${Date.now() - startedAt}`);
  return chunks;
}

/** Replaces one document's stable `${docId}#${chunkIndex}` Chroma records. */
export async function indexDocument(config: PipelineConfig, kbSlug: string, docId: string, source: string, chunks: PreparedChunk[], identity: { pageId?: string; pageTitle: string; chunkingVersion: string }): Promise<number> {
  if (!chunks.length) return 0;
  const startedAt = Date.now();
  try {
    const vectors = await embedTexts(config, chunks.map((chunk) => chunk.text));
    const count = await replaceDocumentVectors(config, kbSlug, docId, source, chunks, vectors, identity);
    console.info(`[DB:knowledge-index] embedded docId=${docId} count=${count} elapsedMs=${Date.now() - startedAt}`);
    return count;
  } catch (error) {
    console.error(`[DB:knowledge-index] failed docId=${docId} count=${chunks.length} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
    throw error;
  }
}

/** Replaces one document using previously generated vectors after every work item succeeds. */
export async function replaceDocumentVectors(
  config: PipelineConfig,
  kbSlug: string,
  docId: string,
  source: string,
  chunks: PreparedChunk[],
  vectors: number[][],
  identity: {
    pageId?: string;
    pageTitle: string;
    chunkingVersion: string;
    kind?: "youtube_question";
    videoId?: string;
    extractionVersion?: string;
  },
): Promise<number> {
  if (vectors.length !== chunks.length) throw new Error("Incomplete document vectors");
  const dimensions = vectors[0]?.length;
  if (chunks.length && (!dimensions || vectors.some((vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))))) {
    throw new Error("Invalid document vectors");
  }
  const startedAt = Date.now();
  const taggedChunks = chunks.filter((chunk) => chunk.topics.length > 0).length;
  console.info(`[DB:knowledge-publish] start docId=${docId} count=${chunks.length} taggedChunks=${taggedChunks}`);
  const collection = await getCollection(config, kbSlug);
  await collection.delete({ where: { docId } });
  for (let start = 0; start < chunks.length; start += 250) {
    const batch = chunks.slice(start, start + 250);
    await collection.upsert({
      ids: batch.map((_, offset) => identity.kind === "youtube_question"
        ? `${docId}#question-${String(start + offset).padStart(6, "0")}`
        : `${docId}#${start + offset}`),
      embeddings: vectors.slice(start, start + 250),
      documents: batch.map((chunk) => chunk.text),
      metadatas: batch.map((chunk, offset) => ({
        docId, source, chunkIndex: start + offset, chunkCount: chunks.length,
        pageTitle: identity.pageTitle, chunkingVersion: identity.chunkingVersion,
        ...(identity.kind ? { kind: identity.kind } : {}),
        ...(identity.videoId ? { videoId: identity.videoId } : {}),
        ...(identity.extractionVersion ? { extractionVersion: identity.extractionVersion } : {}),
        ...(identity.pageId ? { pageId: identity.pageId } : {}),
        ...(chunk.startSeconds !== undefined ? { startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds! } : {}),
        ...(chunk.sectionIds.length ? { sectionIds: chunk.sectionIds } : {}),
        ...(chunk.topics.length ? { topics: chunk.topics } : {}),
        ...(chunk.proposedTopics?.length ? { proposedTopics: chunk.proposedTopics } : {}),
      })),
    });
  }
  console.info(`[DB:knowledge-publish] complete docId=${docId} count=${chunks.length} elapsedMs=${Date.now() - startedAt}`);
  return chunks.length;
}

/** Matches the prototype's best-effort vector removal for a deleted/empty page. */
export async function removeDocument(config: PipelineConfig, kbSlug: string, docId: string): Promise<void> {
  try {
    await removeDocumentStrict(config, kbSlug, docId);
  } catch {
    // A missing collection must not prevent Postgres cleanup.
  }
}

/** Privacy cleanup must fail and retry if vector deletion is not confirmed. */
export async function removeDocumentStrict(config: PipelineConfig, kbSlug: string, docId: string): Promise<void> {
  await (await getCollection(config, kbSlug)).delete({ where: { docId } });
}
