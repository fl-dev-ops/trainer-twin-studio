import type { InterviewQuestionRecord } from "./contract";
import type { PipelineConfig } from "../config";
import type { JobContext } from "../adapters/types";
import { embedTexts, replaceQuestionVectors, type PreparedQuestionRecord } from "../knowledge";
import { QUESTION_GENERATION_VERSION } from "./prompt";

export function questionEmbeddingText(record: InterviewQuestionRecord): string {
  return [
    record.text,
    record.context,
    record.topicSlugs.length ? `Topics: ${record.topicSlugs.join(", ")}` : undefined,
    record.code?.content ? `${record.code.language}:\n${record.code.content}` : undefined,
  ].filter(Boolean).join("\n\n");
}

export async function indexInterviewQuestions(
  config: PipelineConfig,
  job: JobContext,
  docId: string,
  records: InterviewQuestionRecord[],
): Promise<number> {
  const prepared: PreparedQuestionRecord[] = records.map((record) => ({
    id: record.id,
    document: questionEmbeddingText(record),
    metadata: {
      question_type: record.questionType,
      topics: record.topicSlugs,
      record_json: JSON.stringify(record),
      generation_version: QUESTION_GENERATION_VERSION,
      orgId: job.orgId,
      kbId: job.kbId,
      docId,
    },
  }));
  const vectors = prepared.length ? await embedTexts(config, prepared.map(({ document }) => document)) : [];
  return replaceQuestionVectors(config, job, docId, prepared, vectors);
}
