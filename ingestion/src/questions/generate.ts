import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { PipelineConfig } from "../config";
import { createOpenRouter, generateTopicJson } from "../openrouter";
import { parseInterviewQuestionRecord, type InterviewQuestionRecord } from "./contract";
import { QUESTION_GENERATION_SYSTEM_PROMPT, questionGenerationPrompt } from "./prompt";

export type QuestionGenerationChunk = {
  id: string;
  text: string;
  topicSlugs: string[];
  startSeconds?: number;
  endSeconds?: number;
};
export type QuestionGenerationSource = {
  connector: "notion" | "notion_public" | "youtube";
  documentId: string;
  externalId: string;
  title: string;
  url?: string;
};

function identity(record: Omit<InterviewQuestionRecord, "id">) {
  return createHash("sha256").update(JSON.stringify({
    type: record.questionType,
    text: record.text.trim().toLowerCase().replace(/\s+/g, " "),
    code: record.code?.content.trim().replace(/\r\n/g, "\n") ?? "",
  })).digest("hex").slice(0, 24);
}

function candidateRecord(value: unknown, source: QuestionGenerationSource, chunks: Map<string, QuestionGenerationChunk>): InterviewQuestionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_candidate");
  const data = value as Record<string, unknown>;
  const requestedIds = Array.isArray(data.sourceChunkIds) ? data.sourceChunkIds.filter((id): id is string => typeof id === "string") : [];
  const sourceChunks = [...new Set(requestedIds)].map((id) => chunks.get(id)).filter((chunk): chunk is QuestionGenerationChunk => Boolean(chunk));
  if (!sourceChunks.length || sourceChunks.length !== new Set(requestedIds).size) throw new Error("invalid_source");
  const allowedTopics = new Set(sourceChunks.flatMap((chunk) => chunk.topicSlugs));
  const topicSlugs = Array.isArray(data.topicSlugs)
    ? [...new Set(data.topicSlugs.filter((slug): slug is string => typeof slug === "string" && allowedTopics.has(slug)))]
    : [];
  const withoutId = {
    ...data,
    topicSlugs,
    source: {
      ...source,
      chunkIds: sourceChunks.map(({ id }) => id),
      startSeconds: sourceChunks.reduce<number | undefined>((min, chunk) => chunk.startSeconds === undefined ? min : Math.min(min ?? chunk.startSeconds, chunk.startSeconds), undefined),
      endSeconds: sourceChunks.reduce<number | undefined>((max, chunk) => chunk.endSeconds === undefined ? max : Math.max(max ?? chunk.endSeconds, chunk.endSeconds), undefined),
    },
  } as Omit<InterviewQuestionRecord, "id">;
  return parseInterviewQuestionRecord({ ...withoutId, id: `${source.documentId}#question-${identity(withoutId)}` });
}

export async function generateInterviewQuestions(input: {
  pool: Pool;
  config: PipelineConfig;
  source: QuestionGenerationSource;
  chunks: QuestionGenerationChunk[];
}): Promise<InterviewQuestionRecord[]> {
  const startedAt = Date.now();
  try {
  const approvedRows = await input.pool.query<{ slug: string }>('SELECT slug FROM "Topic" WHERE status = \'approved\' ORDER BY slug');
  const approved = new Set(approvedRows.rows.map(({ slug }) => slug));
  if (!approved.size) {
    console.info(`[JOB:question-generation] complete documentId=${input.source.documentId} accepted=0 reason=no_approved_topics`);
    return [];
  }
  const eligible = input.chunks.map((chunk) => ({
    ...chunk,
    topicSlugs: chunk.topicSlugs.filter((slug) => approved.has(slug)),
  })).filter((chunk) => chunk.text.trim() && chunk.topicSlugs.length);
  if (!eligible.length) {
    console.info(`[JOB:question-generation] complete documentId=${input.source.documentId} accepted=0 reason=no_approved_topic_chunks`);
    return [];
  }
  console.info(`[LLM:question-generation] start model=${input.config.questionModel} connector=${input.source.connector} documentId=${input.source.documentId} chunkCount=${eligible.length}`);
  const accepted = new Map<string, InterviewQuestionRecord>();
  const rejected: Record<string, number> = {};
  let rawCandidateCount = 0;
  for (let start = 0; start < eligible.length; start += input.config.topicChunkBatchSize) {
    const batch = eligible.slice(start, start + input.config.topicChunkBatchSize);
    const raw = await generateTopicJson(
      createOpenRouter(input.config.openRouterApiKey),
      input.config.questionModel,
      QUESTION_GENERATION_SYSTEM_PROMPT,
      questionGenerationPrompt({ source: input.source, chunks: batch }),
      "question-generation",
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { questions?: unknown }).questions)) {
      throw new Error("Question generation returned an invalid top-level result");
    }
    const chunkMap = new Map(batch.map((chunk) => [chunk.id, chunk]));
    const candidates = (raw as { questions: unknown[] }).questions;
    rawCandidateCount += candidates.length;
    if (candidates.length > 6) rejected.excess_batch_candidates = (rejected.excess_batch_candidates ?? 0) + candidates.length - 6;
    for (const candidate of candidates.slice(0, 6)) {
      try {
        const record = candidateRecord(candidate, input.source, chunkMap);
        const existing = accepted.get(record.id);
        if (existing) {
          existing.source.chunkIds = [...new Set([...existing.source.chunkIds, ...record.source.chunkIds])];
          existing.topicSlugs = [...new Set([...existing.topicSlugs, ...record.topicSlugs])].sort((left, right) => left.localeCompare(right));
          if (record.source.startSeconds !== undefined) {
            existing.source.startSeconds = Math.min(existing.source.startSeconds ?? record.source.startSeconds, record.source.startSeconds);
          }
          if (record.source.endSeconds !== undefined) {
            existing.source.endSeconds = Math.max(existing.source.endSeconds ?? record.source.endSeconds, record.source.endSeconds);
          }
        } else accepted.set(record.id, record);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "invalid_candidate";
        rejected[reason] = (rejected[reason] ?? 0) + 1;
      }
    }
  }
  const records = [...accepted.values()];
  if (rawCandidateCount > 0 && !records.length) {
    throw new Error("Question generation rejected every returned candidate");
  }
  console.info(`[LLM:question-generation] complete model=${input.config.questionModel} connector=${input.source.connector} documentId=${input.source.documentId} accepted=${records.length} rejected=${JSON.stringify(rejected)} elapsedMs=${Date.now() - startedAt}`);
  console.info(`[JOB:question-generation] complete documentId=${input.source.documentId} accepted=${records.length} rejected=${JSON.stringify(rejected)}`);
  return records;
  } catch (error) {
    console.error(`[LLM:question-generation] failed model=${input.config.questionModel} connector=${input.source.connector} documentId=${input.source.documentId} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
    throw error;
  }
}
