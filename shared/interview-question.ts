import { QUESTION_TYPES, type QuestionType } from "./interview-question-types";

export const QUESTION_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

export type InterviewQuestionRecord = {
  id: string;
  questionType: QuestionType;
  difficulty: QuestionDifficulty;
  topicSlugs: string[];
  text: string;
  spokenText: string;
  source: {
    connector: "notion" | "notion_public" | "youtube";
    documentId: string;
    externalId: string;
    title: string;
    url?: string;
    chunkIds: string[];
    startSeconds?: number;
    endSeconds?: number;
  };
  code?: { language: string; content: string };
  options?: Array<{ id: string; text: string }>;
  context?: string;
  evaluation: {
    referenceAnswer: string;
    keyPoints: string[];
    correctOptionId?: string;
  };
};

/**
 * Physical collection holding typed interview questions. Isolation comes from the per-organization
 * Chroma database, so the name never needs an organization prefix.
 */
export const INTERVIEW_QUESTION_COLLECTION = "kb_questions";

export function interviewQuestionOrgDatabaseName(orgId: string): string {
  return `org_${orgId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value.trim();
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const result = [...new Set(value.map((entry) => text(entry, name)))];
  if (!result.length) throw new Error(`Invalid ${name}`);
  return result;
}

export function parseInterviewQuestionRecord(value: unknown): InterviewQuestionRecord {
  const data = object(value, "question record");
  const questionText = text(data.text, "text");
  const questionType = text(data.questionType, "questionType") as QuestionType;
  if (!(QUESTION_TYPES as readonly string[]).includes(questionType)) throw new Error("Invalid questionType");
  const difficulty = text(data.difficulty, "difficulty") as QuestionDifficulty;
  if (!(QUESTION_DIFFICULTIES as readonly string[]).includes(difficulty)) throw new Error("Invalid difficulty");
  const spokenText = text(data.spokenText, "spokenText");
  if (/```/.test(spokenText)) throw new Error("spokenText must not contain code blocks");

  const sourceData = object(data.source, "source");
  const connector = text(sourceData.connector, "source.connector") as InterviewQuestionRecord["source"]["connector"];
  if (!["notion", "notion_public", "youtube"].includes(connector)) throw new Error("Invalid source.connector");
  const source: InterviewQuestionRecord["source"] = {
    connector,
    documentId: text(sourceData.documentId, "source.documentId"),
    externalId: text(sourceData.externalId, "source.externalId"),
    title: text(sourceData.title, "source.title"),
    chunkIds: strings(sourceData.chunkIds, "source.chunkIds"),
  };
  if (typeof sourceData.url === "string" && sourceData.url.trim()) source.url = sourceData.url.trim();
  if (Number.isFinite(sourceData.startSeconds)) source.startSeconds = Number(sourceData.startSeconds);
  if (Number.isFinite(sourceData.endSeconds)) source.endSeconds = Number(sourceData.endSeconds);

  const evaluationData = object(data.evaluation, "evaluation");
  const evaluation: InterviewQuestionRecord["evaluation"] = {
    referenceAnswer: text(evaluationData.referenceAnswer, "evaluation.referenceAnswer"),
    keyPoints: strings(evaluationData.keyPoints, "evaluation.keyPoints"),
  };
  if (typeof evaluationData.correctOptionId === "string" && evaluationData.correctOptionId.trim()) {
    evaluation.correctOptionId = evaluationData.correctOptionId.trim();
  }

  let code: InterviewQuestionRecord["code"];
  if (data.code !== undefined) {
    const codeData = object(data.code, "code");
    code = { language: text(codeData.language, "code.language"), content: text(codeData.content, "code.content") };
  }
  let options: InterviewQuestionRecord["options"];
  if (data.options !== undefined) {
    if (!Array.isArray(data.options)) throw new Error("Invalid options");
    options = data.options.map((entry) => {
      const option = object(entry, "option");
      return { id: text(option.id, "option.id"), text: text(option.text, "option.text") };
    });
    if (new Set(options.map(({ id }) => id)).size !== options.length) throw new Error("Option ids must be unique");
  }
  const context = typeof data.context === "string" && data.context.trim() ? data.context.trim() : undefined;

  if (questionType === "mcq" && (!options || options.length < 2 || !evaluation.correctOptionId || !options.some(({ id }) => id === evaluation.correctOptionId))) {
    throw new Error("MCQ requires unique options and a matching correctOptionId");
  }
  if (questionType !== "mcq" && evaluation.correctOptionId) {
    throw new Error("correctOptionId is only valid for MCQ questions");
  }
  if (questionType === "code-output" && !code) throw new Error("Code-output requires code");
  if (/\b(?:supplied|following|displayed|given)\b[^.!?]{0,100}\b(?:code|implementation|snippet)\b/i.test(questionText) && !code) {
    throw new Error("Question refers to displayed code but does not include code");
  }
  if (questionType === "machine-coding" && !context) throw new Error("Machine-coding requires context");
  if (questionType === "system-design" && !evaluation.keyPoints.length) throw new Error("System-design requires key points");

  return {
    id: text(data.id, "id"),
    questionType,
    difficulty,
    topicSlugs: strings(data.topicSlugs, "topicSlugs"),
    text: questionText,
    spokenText,
    source,
    ...(code ? { code } : {}),
    ...(options ? { options } : {}),
    ...(context ? { context } : {}),
    evaluation,
  };
}
