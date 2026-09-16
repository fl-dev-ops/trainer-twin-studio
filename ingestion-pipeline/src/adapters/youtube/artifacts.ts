import type { TranscriptSegment } from "./chunking/youtube";
import { parseInterviewQuestionRecord, type InterviewQuestionRecord } from "../../questions/contract";

export type TranscriptArtifact = { version: 1; segments: TranscriptSegment[] };
export type SegmentPayload = {
  batchIndex: number;
  rangeStartMs: number;
  rangeEndMs: number;
  segmentStartIndex: number;
  segmentEndIndex: number;
  transcriptKey: string;
  documentId: string;
  title: string;
  slug: string;
};
export type PublishPayload = { documentId: string; title: string; slug: string; segmentCount: number };
export type QuestionSegmentArtifact = {
  version: 3;
  batchIndex: number;
  questions: InterviewQuestionRecord[];
  vectors: number[][];
};
export type YouTubeQuestionsArtifact = {
  version: 2;
  videoId: string;
  title: string;
  sourceUrl: string;
  extractionVersion: string;
  chunkingVersion: string;
  questions: InterviewQuestionRecord[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ingestion artifact");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string) {
  if (typeof value[key] !== "string" || !value[key]) throw new Error(`Invalid artifact field: ${key}`);
  return value[key] as string;
}

function integerField(value: Record<string, unknown>, key: string) {
  if (!Number.isInteger(value[key]) || Number(value[key]) < 0) throw new Error(`Invalid artifact field: ${key}`);
  return Number(value[key]);
}


export function parseSegmentPayload(value: unknown): SegmentPayload {
  const data = object(value);
  const parsed = {
    batchIndex: integerField(data, "batchIndex"),
    rangeStartMs: integerField(data, "rangeStartMs"),
    rangeEndMs: integerField(data, "rangeEndMs"),
    segmentStartIndex: integerField(data, "segmentStartIndex"),
    segmentEndIndex: integerField(data, "segmentEndIndex"),
    transcriptKey: stringField(data, "transcriptKey"),
    documentId: stringField(data, "documentId"),
    title: stringField(data, "title"),
    slug: stringField(data, "slug"),
  };
  if (parsed.rangeEndMs <= parsed.rangeStartMs || parsed.segmentEndIndex <= parsed.segmentStartIndex) {
    throw new Error("Invalid YouTube segment range");
  }
  return parsed;
}

export function parsePublishPayload(value: unknown): PublishPayload {
  const data = object(value);
  return {
    documentId: stringField(data, "documentId"),
    title: stringField(data, "title"),
    slug: stringField(data, "slug"),
    segmentCount: integerField(data, "segmentCount"),
  };
}

export function parseTranscriptArtifact(value: unknown): TranscriptArtifact {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.segments)) throw new Error("Invalid stored YouTube transcript");
  const segments = data.segments.map((entry) => {
    const segment = object(entry);
    if (typeof segment.text !== "string" || !Number.isFinite(segment.startSeconds)
      || !Number.isFinite(segment.endSeconds) || Number(segment.endSeconds) < Number(segment.startSeconds)) {
      throw new Error("Invalid stored YouTube transcript segment");
    }
    return { text: segment.text, startSeconds: Number(segment.startSeconds), endSeconds: Number(segment.endSeconds) };
  });
  return { version: 1, segments };
}

export function parseQuestionSegmentArtifact(value: unknown): QuestionSegmentArtifact {
  const data = object(value);
  if (data.version !== 3 || !Array.isArray(data.questions) || !Array.isArray(data.vectors)) {
    throw new Error("Invalid stored YouTube question segment artifact");
  }
  const questions = data.questions.map(parseInterviewQuestionRecord);
  const vectors = data.vectors as number[][];
  if (questions.length !== vectors.length || vectors.some((vector) => !Array.isArray(vector))) {
    throw new Error("Stored YouTube question/vector alignment is invalid");
  }
  return { version: 3, batchIndex: integerField(data, "batchIndex"), questions, vectors };
}
