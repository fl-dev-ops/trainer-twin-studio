import { createHash } from "node:crypto";
import type { Collection, Metadata } from "chromadb";
import type { YouTubeQuestionsArtifact } from "../../src/adapters/youtube/artifacts";
import type { ExtractedQuestion } from "../../src/adapters/youtube/questions";

export type RecordSnapshot = {
  id: string;
  text: string;
  embedding: number[];
  metadata: Metadata;
};

export type Reconciliation = {
  artifact: YouTubeQuestionsArtifact;
  changedQuestionIndices: Set<number>;
  newlyApprovedTopicCount: number;
};

function stringList(value: unknown, field: string, index: number, docId: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${field} at index=${index} for docId=${docId}`);
  }
  return [...new Set(value as string[])].sort((left, right) => left.localeCompare(right));
}

export function parseQuestionsArtifact(raw: unknown, docId: string): YouTubeQuestionsArtifact {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid questions artifact for docId=${docId}`);
  const data = raw as Record<string, unknown>;
  if (data.version !== 1 || typeof data.videoId !== "string" || !data.videoId
    || typeof data.title !== "string" || typeof data.sourceUrl !== "string"
    || typeof data.extractionVersion !== "string" || !data.extractionVersion
    || typeof data.chunkingVersion !== "string" || !data.chunkingVersion
    || !Array.isArray(data.questions)) {
    throw new Error(`Invalid questions artifact contract for docId=${docId}`);
  }
  const questions: ExtractedQuestion[] = data.questions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid question at index=${index} for docId=${docId}`);
    const question = value as Record<string, unknown>;
    if (typeof question.text !== "string" || !question.text.trim()
      || typeof question.startSeconds !== "number" || !Number.isFinite(question.startSeconds) || question.startSeconds < 0
      || typeof question.endSeconds !== "number" || !Number.isFinite(question.endSeconds) || question.endSeconds < question.startSeconds) {
      throw new Error(`Invalid question fields at index=${index} for docId=${docId}`);
    }
    return {
      text: question.text,
      startSeconds: question.startSeconds,
      endSeconds: question.endSeconds,
      topics: stringList(question.topics, "topics", index, docId),
      proposedTopics: stringList(question.proposedTopics, "proposedTopics", index, docId),
    };
  });
  return {
    version: 1,
    videoId: data.videoId,
    title: data.title,
    sourceUrl: data.sourceUrl,
    extractionVersion: data.extractionVersion,
    chunkingVersion: data.chunkingVersion,
    questions,
  };
}

export function reconcileArtifact(artifact: YouTubeQuestionsArtifact, approvedTopics: Set<string>): Reconciliation {
  const changedQuestionIndices = new Set<number>();
  let newlyApprovedTopicCount = 0;
  const questions = artifact.questions.map((question, index) => {
    const promoted = question.proposedTopics.filter((slug) => approvedTopics.has(slug));
    if (!promoted.length) return question;
    changedQuestionIndices.add(index);
    newlyApprovedTopicCount += promoted.length;
    return {
      ...question,
      topics: [...new Set([...question.topics, ...promoted])].sort((left, right) => left.localeCompare(right)),
      proposedTopics: question.proposedTopics.filter((slug) => !approvedTopics.has(slug)).sort((left, right) => left.localeCompare(right)),
    };
  });
  return { artifact: { ...artifact, questions }, changedQuestionIndices, newlyApprovedTopicCount };
}

export async function fetchDocumentRecords(collection: Collection, docId: string): Promise<RecordSnapshot[]> {
  const records: RecordSnapshot[] = [];
  for (let offset = 0; ; offset += 250) {
    const page = await collection.get({ where: { docId }, offset, limit: 250, include: ["documents", "metadatas", "embeddings"] });
    for (const [index, id] of page.ids.entries()) {
      const text = page.documents[index];
      const embedding = page.embeddings?.[index];
      const metadata = page.metadatas[index];
      if (typeof text !== "string" || !embedding?.length || !metadata) throw new Error(`Incomplete Chroma snapshot for record id=${id}`);
      records.push({ id, text, embedding, metadata });
    }
    if (page.ids.length < 250) break;
  }
  return records.sort((left, right) => Number(left.metadata.chunkIndex) - Number(right.metadata.chunkIndex));
}

function sameList(value: unknown, expected: string[]) {
  const actual = Array.isArray(value) ? (value as string[]).slice().sort((left, right) => left.localeCompare(right)) : [];
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

export function recordsNeedingUpdate(
  docId: string,
  records: RecordSnapshot[],
  original: YouTubeQuestionsArtifact,
  updated: YouTubeQuestionsArtifact,
): RecordSnapshot[] {
  if (records.length !== original.questions.length || updated.questions.length !== original.questions.length) {
    throw new Error(`Question/Chroma count mismatch for docId=${docId}`);
  }
  const updates: RecordSnapshot[] = [];
  for (const [index, record] of records.entries()) {
    const before = original.questions[index];
    const after = updated.questions[index];
    const expectedId = `${docId}#question-${String(index).padStart(6, "0")}`;
    if (record.id !== expectedId || record.text !== before.text || record.metadata.docId !== docId
      || record.metadata.kind !== "youtube_question" || Number(record.metadata.chunkIndex) !== index
      || Number(record.metadata.chunkCount) !== records.length
      || Number(record.metadata.startSeconds) !== before.startSeconds || Number(record.metadata.endSeconds) !== before.endSeconds) {
      throw new Error(`Question/Chroma identity mismatch at index=${index} for docId=${docId}`);
    }
    const alreadyUpdated = sameList(record.metadata.topics, after.topics)
      && sameList(record.metadata.proposedTopics, after.proposedTopics);
    if (alreadyUpdated) continue;
    const stillOriginal = sameList(record.metadata.topics, before.topics)
      && sameList(record.metadata.proposedTopics, before.proposedTopics);
    if (!stillOriginal) throw new Error(`Unexpected topic metadata at index=${index} for docId=${docId}`);
    const metadata: Metadata = { ...record.metadata };
    if (after.topics.length) metadata.topics = after.topics;
    else delete metadata.topics;
    if (after.proposedTopics.length) metadata.proposedTopics = after.proposedTopics;
    else delete metadata.proposedTopics;
    updates.push({ ...record, metadata });
  }
  return updates;
}

export function recordFingerprint(record: RecordSnapshot, includeTopics = true) {
  const metadata = Object.fromEntries(Object.entries(record.metadata)
    .filter(([key]) => includeTopics || (key !== "topics" && key !== "proposedTopics"))
    .sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify({ ...record, metadata })).digest("hex");
}

export function artifactKeyFor(originalKey: string, artifact: YouTubeQuestionsArtifact) {
  const digest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex").slice(0, 16);
  const slash = originalKey.lastIndexOf("/");
  if (slash < 0) throw new Error("Invalid questions artifact key");
  return `${originalKey.slice(0, slash)}/topic-reconciliations/${digest}/questions.json`;
}
