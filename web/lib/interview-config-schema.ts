import { z } from "zod";
import { QUESTION_TYPES } from "@shared/interview-question-types";

const topicSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
export const questionTypeSchema = z.enum(QUESTION_TYPES);
export const questionCountsSchema = z.partialRecord(questionTypeSchema, z.number().int().min(0));

const sharedFields = {
  schema_version: z.literal(1),
  follow_ups_per_main_question: z.number().int().min(0).max(3),
};

export const resumeInterviewConfigSchema = z.object({
  ...sharedFields,
  type: z.literal("resume"),
  main_questions: z.number().int().min(1).max(20).default(4),
  max_section_highlights: z.number().int().min(1).max(20).optional(),
}).strict();

export const technicalInterviewConfigSchema = z.object({
  ...sharedFields,
  type: z.literal("technical"),
  // Empty is a valid authoring state. Publishing and runtime compilation require topics.
  topic_slugs: z.array(topicSlugSchema),
  question_counts: questionCountsSchema,
}).strict().superRefine((config, ctx) => {
  if (Object.values(config.question_counts).reduce((sum, count) => sum + count, 0) === 0) {
    ctx.addIssue({ code: "custom", message: "Technical scenarios require at least one main question", path: ["question_counts"] });
  }
});

export const interviewConfigSchema = z.discriminatedUnion("type", [
  resumeInterviewConfigSchema,
  technicalInterviewConfigSchema,
]);

export type InterviewConfig = z.infer<typeof interviewConfigSchema>;
export type ResumeInterviewConfig = z.infer<typeof resumeInterviewConfigSchema>;
export type TechnicalInterviewConfig = z.infer<typeof technicalInterviewConfigSchema>;

export const DEFAULT_RESUME_INTERVIEW_CONFIG: InterviewConfig = {
  schema_version: 1,
  type: "resume",
  follow_ups_per_main_question: 1,
  main_questions: 4,
};

export const DEFAULT_TECHNICAL_QUESTION_COUNTS: TechnicalInterviewConfig["question_counts"] = {
  verbal: 2,
  mcq: 2,
  coding: 1,
  "code-output": 2,
  "system-design": 1,
};
