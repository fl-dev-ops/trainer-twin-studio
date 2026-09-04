import type { Pool } from "pg";
import type { PipelineConfig } from "../../config";
import { createOpenRouter, generateTopicJson } from "../../openrouter";
import { createTopicResolver, normalizeTopicSlug, parseTopicProposals, type TopicInfo } from "../../topics/normalization";

export const YOUTUBE_QUESTION_EXTRACTION_VERSION = "youtube-substantive-questions-v1";

export type QuestionSourceChunk = {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type ExtractedQuestion = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  topics: string[];
  proposedTopics: string[];
};

type CatalogTopic = TopicInfo & { status: "approved" | "proposed" };
type RawQuestion = {
  text?: unknown;
  timestamp?: unknown;
  startSeconds?: unknown;
  sourceChunkIds?: unknown;
  topicSlugs?: unknown;
};

const EXTRACTION_SYSTEM_PROMPT = `Extract only explicit, substantive questions spoken in the supplied YouTube transcript chunks.

Rules:
- Do not generate study questions from declarative statements.
- Exclude rhetorical filler, greetings, confirmations, and logistical questions such as "Can you hear me?" or "Does that make sense?".
- Lightly repair casing, punctuation, and obvious caption fragmentation without changing meaning or adding facts.
- Never answer a question.
- A question may reference one or more contiguous source chunk IDs.
- Include the timestamp (e.g. "02:12" or seconds) from the transcript line where the question begins.
- Every question MUST have 1 to 4 concise, specific topic slugs assigned in topicSlugs (never return an empty array). Include both the general technology (e.g. "react", "javascript") and specific concepts (e.g. "reconciliation", "closures", "higher-order-components", "execution-context", "v8-engine", "virtual-dom", "machine-coding", "interview-preparation").
- Strongly prefer matching from the supplied approvedTopics list where relevant. If a specific concept is not in approvedTopics, propose a new concise slug.
- Return JSON only in this shape: {"topics":[{"slug":"topic-slug","description":"Short description"}],"questions":[{"text":"Question?","timestamp":"02:12","sourceChunkIds":["chunk-0"],"topicSlugs":["topic-slug"]}]}.
- Return empty arrays when no substantive question is spoken.`;
function extractionPrompt(videoTitle: string, chunks: QuestionSourceChunk[], approvedTopics: string[]) {
  return JSON.stringify({ videoTitle, approvedTopics, chunks });
}

function normalizedQuestionText(value: unknown) {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return "";
  return /[?？]$/.test(text) ? text : `${text}?`;
}

function parseTimestampSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    const parts = trimmed.split(":").map(Number);
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n >= 0)) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0)) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }
  return null;
}

async function resolveTopics(pool: Pool, proposals: TopicInfo[]) {
  const catalog = await pool.query<CatalogTopic>('SELECT slug, description, status FROM "Topic" ORDER BY slug');
  const bySlug = new Map(catalog.rows.map((topic) => [topic.slug, topic]));
  const resolveCatalog = createTopicResolver(bySlug.keys());
  const resolved = new Map<string, CatalogTopic>();
  for (const proposal of proposals) {
    const knownSlug = resolveCatalog(proposal.slug);
    if (knownSlug) {
      resolved.set(proposal.slug, bySlug.get(knownSlug)!);
      continue;
    }
    const inserted = await pool.query<CatalogTopic>(`INSERT INTO "Topic" (id, slug, description, status, "createdAt")
      VALUES ($1,$2,$3,'proposed',NOW())
      ON CONFLICT (slug) DO UPDATE SET description = "Topic".description
      RETURNING slug, description, status`, [crypto.randomUUID(), proposal.slug, proposal.description]);
    resolved.set(proposal.slug, inserted.rows[0]);
  }
  return resolved;
}

/** Extracts timed question occurrences and resolves predicted labels against the topic catalog. */
export async function extractYouTubeQuestions(
  pool: Pool,
  config: PipelineConfig,
  videoTitle: string,
  chunks: QuestionSourceChunk[],
): Promise<ExtractedQuestion[]> {
  if (!chunks.length) return [];
  const startedAt = Date.now();
  const approvedRes = await pool.query<{ slug: string }>('SELECT slug FROM "Topic" WHERE status = \'approved\' ORDER BY slug');
  const approvedTopics = approvedRes.rows.map((r) => r.slug);
  const raw = await generateTopicJson(
    createOpenRouter(config.openRouterApiKey),
    config.topicModel,
    EXTRACTION_SYSTEM_PROMPT,
    extractionPrompt(videoTitle, chunks, approvedTopics),
    "youtube-questions",
  );
  if (!raw || typeof raw !== "object" || !("topics" in raw) || !Array.isArray(raw.topics)
    || !("questions" in raw) || !Array.isArray(raw.questions)) {
    throw new Error("YouTube question extraction returned an invalid top-level result");
  }
  const proposals = parseTopicProposals(raw);
  const proposalBySlug = new Map(proposals.map((topic) => [topic.slug, topic]));
  const resolveProposal = createTopicResolver(proposalBySlug.keys());
  const resolvedTopics = await resolveTopics(pool, proposals);
  const chunkIndexes = new Map(chunks.map((chunk, index) => [chunk.id, index]));
  const source = raw.questions as RawQuestion[];
  const questions: ExtractedQuestion[] = [];
  const seen = new Set<string>();
  let invalidText = 0;
  let invalidSource = 0;
  let invalidTopics = 0;
  let duplicates = 0;

  for (const candidate of source) {
    const text = normalizedQuestionText(candidate?.text);
    if (!text) {
      invalidText++;
      continue;
    }
    const ids = Array.isArray(candidate.sourceChunkIds)
      ? [...new Set(candidate.sourceChunkIds.filter((id): id is string => typeof id === "string"))] : [];
    const indexes = ids.map((id) => chunkIndexes.get(id)).filter((index): index is number => index !== undefined).sort((a, b) => a - b);
    const sourceStart = indexes.length ? chunks[indexes[0]].startSeconds : chunks[0]?.startSeconds ?? 0;
    const sourceEnd = indexes.length ? chunks[indexes[indexes.length - 1]].endSeconds : chunks[chunks.length - 1]?.endSeconds ?? 0;
    const parsedTime = parseTimestampSeconds(candidate.timestamp ?? candidate.startSeconds);
    const startSeconds = (parsedTime !== null && parsedTime >= sourceStart && parsedTime <= sourceEnd)
      ? parsedTime
      : sourceStart;
    const endSeconds = sourceEnd;

    const predicted = Array.isArray(candidate.topicSlugs)
      ? candidate.topicSlugs.filter((topic): topic is string => typeof topic === "string").slice(0, 4) : [];
    const catalogTopics = new Map<string, CatalogTopic>();
    for (const topic of predicted) {
      const proposalSlug = resolveProposal(topic) ?? normalizeTopicSlug(topic);
      const resolved = resolvedTopics.get(proposalSlug);
      if (resolved) catalogTopics.set(resolved.slug, resolved);
    }
    if (!catalogTopics.size) {
      const lower = text.toLowerCase();
      const fallbacks: string[] = [];
      if (lower.includes("react")) fallbacks.push("react");
      if (lower.includes("reconcil")) fallbacks.push("reconciliation");
      if (lower.includes("closure")) fallbacks.push("closures");
      if (lower.includes("higher order") || lower.includes("hoc")) fallbacks.push("higher-order-components");
      if (lower.includes("javascript") || lower.includes("js")) fallbacks.push("javascript");
      if (lower.includes("hoist")) fallbacks.push("hoisting");
      if (lower.includes("execution context")) fallbacks.push("execution-context");
      if (lower.includes("machine coding")) fallbacks.push("machine-coding");
      if (lower.includes("interview") || lower.includes("prepare")) fallbacks.push("interview-preparation");
      if (!fallbacks.length) fallbacks.push("frontend-development");

      for (const slug of fallbacks) {
        const resolved = resolvedTopics.get(slug);
        if (resolved) catalogTopics.set(resolved.slug, resolved);
        else catalogTopics.set(slug, { slug, description: slug.replace(/-/g, " "), status: "approved" });
      }
    }
    const duplicateKey = `${text.toLowerCase()}\u0000${startSeconds}\u0000${endSeconds}`;
    if (seen.has(duplicateKey)) {
      duplicates++;
      continue;
    }
    seen.add(duplicateKey);
    const topics = [...catalogTopics.values()].map((topic) => topic.slug).sort();
    const proposedTopics = [...catalogTopics.values()].filter((topic) => topic.status === "proposed").map((topic) => topic.slug).sort();
    questions.push({ text, startSeconds, endSeconds, topics, proposedTopics });
  }

  console.info(`[LLM:youtube-questions] parsed chunks=${chunks.length} accepted=${questions.length} dropped=${invalidText + invalidSource + invalidTopics + duplicates} invalidText=${invalidText} invalidSource=${invalidSource} invalidTopics=${invalidTopics} duplicates=${duplicates} elapsedMs=${Date.now() - startedAt}`);
  return questions;
}
