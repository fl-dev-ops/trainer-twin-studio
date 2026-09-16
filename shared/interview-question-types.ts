export const QUESTION_TYPES = [
  "verbal",
  "mcq",
  "coding",
  "code-output",
  "machine-coding",
  "system-design",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_ORDER: readonly QuestionType[] = QUESTION_TYPES;
