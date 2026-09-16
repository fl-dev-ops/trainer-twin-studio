import type { InterviewQuestionRecord } from "@shared/interview-question";

export type CandidateQuestion = Omit<InterviewQuestionRecord, "evaluation"> & {
  surface: "verbal" | "choice" | "code" | "whiteboard";
  starterCode?: string;
  readOnly?: boolean;
};

export function toCandidateQuestion(record: InterviewQuestionRecord): CandidateQuestion {
  const { evaluation: _evaluation, ...candidate } = record;
  const surface = record.questionType === "mcq"
    ? "choice"
    : record.questionType === "system-design"
      ? "whiteboard"
      : record.code || ["coding", "code-output", "machine-coding"].includes(record.questionType)
        ? "code"
        : "verbal";
  return {
    ...candidate,
    surface,
    ...(record.code ? { starterCode: record.code.content } : {}),
    ...(record.code && !["coding", "machine-coding"].includes(record.questionType) ? { readOnly: true } : {}),
  };
}
