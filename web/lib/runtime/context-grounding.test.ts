import { describe, expect, it } from "bun:test";
import { buildSpecs } from "./compiler";
import { adaptOpeningWithoutContext, formatSessionFacts } from "./openai";

describe("Context Grounding & Document Ingestion", () => {
  const baseConfig = {
    persona: {
      id: "persona-vasanth",
      version: 1,
      data: {
        name: "Vasanth",
        style: {},
        decision_preferences: {},
      },
    },
    agent: {
      id: "resume-mastery",
      version: 1,
      data: {
        name: "Resume Deep Dive",
        objective: "Establish what the candidate worked on and owned.",
        opening: "Choose one important project from your resume and explain the problem it was intended to solve.",
        config: {
          context: { mode: "resume_grounding", required: true },
          actions: {
            allowed: ["probe_required_evidence", "close_session"],
            default: "probe_required_evidence",
          },
          rendering: {
            maximum_words: 45,
            maximum_question_marks: 1,
            one_focal_ask: true,
            deterministic_closing: true,
          },
          turns: { maximum: 8 },
        },
        stages: [
          {
            id: "stage-1",
            name: "Project Deep Dive",
            objective: "Deep dive project",
            opening: "Let's dive in.",
            config: {
              evidence: {
                definitions: { ownership: "personal ownership" },
                keys: ["ownership"],
                completion_keys: ["ownership"],
              },
              turns: { minimum: 2, maximum: 4 },
            },
          },
        ],
      },
    },
    domain: {
      slug: "software-engineering",
      version: 1,
      data: { principles: ["Ask follow-ups."] },
    },
  };

  it("buildSpecs extracts contextDocument when present in configuration", () => {
    const specs = buildSpecs({
      ...baseConfig,
      context: {
        id: "doc-123",
        name: "karthik_resume.pdf",
        content: "# Karthik Resume\nBuilt distributed cache at Stripe using Redis.",
      },
    });

    expect(specs.contextDocument).toEqual({
      id: "doc-123",
      name: "karthik_resume.pdf",
      content: "# Karthik Resume\nBuilt distributed cache at Stripe using Redis.",
    });
  });

  it("buildSpecs sets contextDocument to null when context is missing or empty", () => {
    const specsNoContext = buildSpecs({ ...baseConfig, context: null });
    expect(specsNoContext.contextDocument).toBeNull();

    const specsEmptyContent = buildSpecs({
      ...baseConfig,
      context: { id: "doc-123", name: "empty.txt", content: "   " },
    });
    expect(specsEmptyContent.contextDocument).toBeNull();
  });

  it("formatSessionFacts exposes only a lightweight document manifest", () => {
    const specs = buildSpecs({
      ...baseConfig,
      documentManifests: [{
        id: "doc-1",
        name: "candidate_cv.pdf",
        kind: "document",
        mimeType: "application/pdf",
        size: 100,
        pageCount: 2,
        headings: ["Experience", "Projects"],
      }],
      sessionDocumentIds: ["doc-1"],
    });

    const facts = formatSessionFacts(specs);
    expect(facts).toContain("SESSION DOCUMENT MANIFEST");
    expect(facts).toContain("candidate_cv.pdf");
    expect(facts).toContain("Experience, Projects");
    expect(facts).not.toContain("Led team of 5 backend engineers");
    expect(facts).toContain("Do not claim facts from a file unless a TARGETED DOCUMENT EXCERPT");
  });

  it("formatSessionFacts generates negative grounding instructions when contextDocument is null", () => {
    const specs = buildSpecs({
      ...baseConfig,
      context: null,
    });

    const facts = formatSessionFacts(specs);
    expect(facts).toContain("SESSION DOCUMENT MANIFEST: None attached.");
    expect(facts).toContain("Do NOT claim to have access to, see, or possess the learner's resume, document, or image.");
    expect(facts).toContain("truthfully state that no file was uploaded and ask the learner to describe their experience verbally.");
  });

  it("adaptOpeningWithoutContext rewrites resume-dependent openings to experience-based openings", () => {
    const resumeOpening = "Choose one important project from your resume and explain the problem it was intended to solve.";
    const adapted = adaptOpeningWithoutContext(resumeOpening);
    expect(adapted).toBe("Choose one important project from your experience and explain the problem it was intended to solve.");

    const uploadedDocOpening = "Tell me about a key milestone from your uploaded document.";
    expect(adaptOpeningWithoutContext(uploadedDocOpening)).toBe("Tell me about a key milestone from your experience.");

    const standardOpening = "Welcome to the interview session. Let's begin.";
    expect(adaptOpeningWithoutContext(standardOpening)).toBe("Welcome to the interview session. Let's begin.");
  });
});
