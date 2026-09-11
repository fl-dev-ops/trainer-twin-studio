import type { Pool } from "pg";
import type { PipelineConfig } from "../../config";
import { createOpenRouter, generateTopicJson } from "../../openrouter";
import { createTopicResolver, normalizeTopicSlug, parseTopicProposals, type TopicInfo } from "../../topics/normalization";

export const YOUTUBE_QUESTION_EXTRACTION_VERSION = "youtube-multimodal-questions-v2";

export type QuestionSourceChunk = {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type QuestionType = "verbal" | "code-output" | "coding" | "machine-coding" | "system-design" | "mcq";

export type ExtractedQuestion = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  topics: string[];
  proposedTopics: string[];
  questionType: QuestionType;
  difficulty: "easy" | "medium" | "hard";
  code?: {
    language: string;
    content: string;
  };
  context?: string;
};

type CatalogTopic = TopicInfo & { status: "approved" | "proposed" };
type RawQuestion = {
  text?: unknown;
  timestamp?: unknown;
  startSeconds?: unknown;
  sourceChunkIds?: unknown;
  topicSlugs?: unknown;
  questionType?: unknown;
  difficulty?: unknown;
  code?: unknown;
  context?: unknown;
};

const EXTRACTION_SYSTEM_PROMPT = `Extract explicit technical interview questions spoken or presented in the supplied YouTube transcript chunks, including verbal probes, coding challenges, code output prediction, machine coding, and system design.

Rules:
1. Extract ONLY domain-specific technical questions (concepts, runtime behavior, syntax, frameworks, architecture, debugging, or algorithms in React, JavaScript, TypeScript, Next.js, Node.js, Java, Python, databases, system design, etc.).
2. Categorize each question under questionType:
   - "verbal": conceptual probes, explanations, mechanisms, trade-offs.
   - "code-output": questions asking what a code snippet logs, evaluates to, or throws. Reconstruct the code snippet into code: {"language": "...", "content": "..."}. Ensure the question text is self-contained.
   - "coding": questions requiring the candidate to implement a function, hook, utility, or algorithm. If starter code or template is provided, include it in code.
   - "machine-coding": practical UI component builds or end-to-end frontend feature implementations (e.g. live chat UI, autocomplete, infinite scroll). Include requirements in context.
   - "system-design": frontend architecture, scaling, caching, API protocols, or full-stack system design questions. Include requirements or scenario in context.
   - "mcq": multiple-choice questions if spoken or presented with distinct options.
3. If the transcript discusses or dictates a code snippet for the question, extract/reconstruct it into code: {"language": "javascript" | "jsx" | "typescript" | "python", "content": "..."}.
4. Make question text self-contained. Never emit a bare "What is the output?" or "Can you write this?"; always provide the context of what is being tested.
5. Assign difficulty: "easy" | "medium" | "hard".
6. Exclude generic screening, HR, or behavioral questions ("Tell me about yourself", "Notice period", "What are your skills").
7. Exclude rhetorical filler ("Can you hear me?", "Does that make sense?").
8. Include the timestamp (e.g. "02:12" or seconds) where the question begins.
9. Every question MUST have 1 to 4 concise topic slugs in topicSlugs matching general technology ("react", "javascript") and specific concepts ("reconciliation", "closures", "hooks", "event-loop"). Prefer matching supplied approvedTopics.
10. Return JSON only in this shape:
{
  "topics": [{"slug": "topic-slug", "description": "Short description"}],
  "questions": [
    {
      "text": "Self-contained technical question?",
      "questionType": "verbal" | "code-output" | "coding" | "machine-coding" | "system-design" | "mcq",
      "difficulty": "easy" | "medium" | "hard",
      "code": {"language": "javascript", "content": "code snippet if applicable"},
      "context": "Scenario or requirements if applicable",
      "timestamp": "02:12",
      "sourceChunkIds": ["chunk-0"],
      "topicSlugs": ["react", "virtual-dom"]
    }
  ]
}
Return empty arrays when no substantive technical question is spoken.`;
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
    const rawType = String(candidate.questionType || "verbal").toLowerCase();
    const questionType: QuestionType = ["verbal", "code-output", "coding", "machine-coding", "system-design", "mcq"].includes(rawType)
      ? (rawType as QuestionType)
      : "verbal";

    const rawDiff = String(candidate.difficulty || "medium").toLowerCase();
    const difficulty: "easy" | "medium" | "hard" = ["easy", "medium", "hard"].includes(rawDiff)
      ? (rawDiff as "easy" | "medium" | "hard")
      : "medium";

    let code: { language: string; content: string } | undefined;
    if (candidate.code && typeof candidate.code === "object") {
      const c = candidate.code as { language?: unknown; content?: unknown };
      if (typeof c.content === "string" && c.content.trim()) {
        code = {
          language: typeof c.language === "string" && c.language.trim() ? c.language.trim() : "javascript",
          content: c.content.trim(),
        };
      }
    }

    const context = typeof candidate.context === "string" && candidate.context.trim()
      ? candidate.context.trim()
      : undefined;

    const topics = [...catalogTopics.values()].map((topic) => topic.slug).sort();
    const proposedTopics = [...catalogTopics.values()].filter((topic) => topic.status === "proposed").map((topic) => topic.slug).sort();
    questions.push({ text, startSeconds, endSeconds, topics, proposedTopics, questionType, difficulty, code, context });
  }

  console.info(`[LLM:youtube-questions] parsed chunks=${chunks.length} accepted=${questions.length} dropped=${invalidText + invalidSource + invalidTopics + duplicates} invalidText=${invalidText} invalidSource=${invalidSource} invalidTopics=${invalidTopics} duplicates=${duplicates} elapsedMs=${Date.now() - startedAt}`);
  return questions;
}
