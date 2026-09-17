import { describe, expect, it } from "bun:test";
import {
  interviewConfigSchema,
  resumeInterviewConfigSchema,
  DEFAULT_RESUME_INTERVIEW_CONFIG,
} from "./interview-config-schema";

describe("interview-config-schema", () => {
  it("defaults main_questions to 4 for resume interview config when omitted", () => {
    const parsed = resumeInterviewConfigSchema.parse({
      schema_version: 1,
      type: "resume",
      follow_ups_per_main_question: 1,
    });
    expect(parsed.main_questions).toBe(4);
    expect(parsed.type).toBe("resume");
    expect(parsed.follow_ups_per_main_question).toBe(1);
  });

  it("accepts custom main_questions for resume interview config", () => {
    const parsed = resumeInterviewConfigSchema.parse({
      schema_version: 1,
      type: "resume",
      follow_ups_per_main_question: 2,
      main_questions: 3,
    });
    expect(parsed.main_questions).toBe(3);
    expect(parsed.follow_ups_per_main_question).toBe(2);
  });

  it("accepts max_section_highlights for resume interview config", () => {
    const parsed = resumeInterviewConfigSchema.parse({
      schema_version: 1,
      type: "resume",
      follow_ups_per_main_question: 1,
      max_section_highlights: 5,
    });
    expect(parsed.max_section_highlights).toBe(5);
  });

  it("validates main_questions bounds", () => {
    expect(() =>
      resumeInterviewConfigSchema.parse({
        schema_version: 1,
        type: "resume",
        follow_ups_per_main_question: 1,
        main_questions: 0,
      })
    ).toThrow();

    expect(() =>
      resumeInterviewConfigSchema.parse({
        schema_version: 1,
        type: "resume",
        follow_ups_per_main_question: 1,
        main_questions: 25,
      })
    ).toThrow();
  });

  it("parses resume config through interviewConfigSchema union", () => {
    const parsed = interviewConfigSchema.parse({
      schema_version: 1,
      type: "resume",
      follow_ups_per_main_question: 2,
      main_questions: 5,
    });
    expect(parsed.type).toBe("resume");
    if (parsed.type === "resume") {
      expect(parsed.main_questions).toBe(5);
    }
  });

  it("DEFAULT_RESUME_INTERVIEW_CONFIG has main_questions: 4", () => {
    expect(DEFAULT_RESUME_INTERVIEW_CONFIG.type).toBe("resume");
    if (DEFAULT_RESUME_INTERVIEW_CONFIG.type === "resume") {
      expect(DEFAULT_RESUME_INTERVIEW_CONFIG.main_questions).toBe(4);
    }
  });
});
