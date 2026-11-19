import { expect, test } from "bun:test";
import { interviewSkillPackage } from "@/lib/interview-skill";
import { scenarioManifestSchema, skillBody, stepGoal } from "@/lib/scenario-ingest";

// Synthetic interviewer-shaped fixtures with the same structure as the inventoried interviews (no real content).
const resumeInterview = {
  slug: "impact-check", name: "Impact Check", version: 7,
  data: {
    name: "Impact Check", objective: "Validate quantified résumé claims.",
    instruction: "Challenge every number.\n\\- What was the baseline?", principles: ["One question at a time.", "Never accept a number without its method."],
    opening: "Hi, let's look at one number on your résumé.", voiceId: "voice-1", introVideo: "intros/impact.mp4",
    config: {
      tools: [], turns: { maximum: 12 },
      context: { mode: "resume_topics_only", label: "Documents", required: true, prompt: "Upload your résumé. It will be deleted after this session. Then we begin." },
      interview: { type: "resume", main_questions: 4, follow_ups_per_main_question: 2 },
      evidence: { statuses: ["untested", "partial", "sufficient"] },
      rendering: { maximum_words: 45, one_focal_ask: true, maximum_question_marks: 1, deterministic_closing: true },
    },
    stages: [{
      id: "impact-validation", name: "Impact Validation", objective: "Validate quantified claims.", opening: "Pick your strongest number.",
      config: {
        turns: { minimum: 6, maximum: 10 }, actions: { allowed: ["probe_required_evidence", "narrow_hint"] },
        context: { mode: "resume_topics_only", required: true }, claim_handling: "resume_evidence",
        evidence: { keys: ["baseline", "causal_link"], definitions: { baseline: "Value before the change.", causal_link: "Why the work caused it." }, completion_keys: ["baseline"] },
        knowledge: { tags: ["metrics"] },
      },
    }],
    classifications: { strong: "Fully explained.", vague: "Lacks detail." },
    knowledge_grounding: [{ queryGuidance: "Focus on baseline and method." }],
  },
};
const technicalInterview = {
  slug: "concepts", name: "Concepts", version: 3,
  data: {
    name: "Concepts", objective: "Probe conceptual understanding.", instruction: "Go deep.", principles: [],
    config: { context: { mode: "none" }, interview: { type: "technical", topic_slugs: ["closures", "event-loop"], question_counts: { mcq: 1, coding: 2, verbal: 2 }, follow_ups_per_main_question: 3 } },
    stages: [{ id: "conceptual", name: "Conceptual", objective: "Explain mechanisms.", config: { evidence: { keys: ["mechanism"] } } }],
  },
};

test("a résumé interview ports verbatim into a valid authored skill with its upload, tools and settings", () => {
  const pkg = interviewSkillPackage(resumeInterview);
  expect(scenarioManifestSchema.safeParse(pkg.scenario).success).toBe(true);
  expect(pkg.scenario).toMatchObject({
    scenario: "impact-check", name: "Impact Check (skill)", trainer_role: "Interviewer", learner_role: "Candidate",
    steps: [{ id: "impact-validation", name: "Impact Validation", trainer_moves: ["probe_required_evidence", "narrow_hint"], learner_moves: [] }],
  });
  // Authored text is carried verbatim.
  expect(pkg.skill).toContain("Challenge every number.\n\\- What was the baseline?");
  for (const line of ["- One question at a time.", "Begin with: Hi, let's look at one number on your résumé.", "Ask 4 main questions",
    "Up to 2 follow-up questions per main question", "at most 12 of your turns", "★ baseline: Value before the change.", "  - causal link: Why the work caused it.",
    "Length: 6–10 of your turns.", "Open this stage with: Pick your strongest number.", "- strong: Fully explained.", "untested, partial, sufficient",
    "Focus on baseline and method.", "At most 45 words per turn. One focal ask per turn. At most 1 question mark per turn.", "Use read_document", "end the call"]) {
    expect(pkg.skill).toContain(line);
  }
  expect(pkg.skill.startsWith("---\nname: \"Impact Check\"\n")).toBe(true);
  expect(pkg.skill).toContain('ported_from: "impact-check@v7"');
  // The step goal is readable the way the runtime reads authored skills.
  expect(stepGoal(skillBody(pkg.skill), "impact-validation")).toBe("Validate quantified claims.");
  expect(pkg.items).toEqual([]);
  expect(pkg.settings).toEqual({
    before: { preScreenshare: false, preUpload: true, duringUpload: false, uploadTitle: "Documents", uploadInstruction: "Upload your résumé. Then we begin." },
    tools: { codeEditor: false, choice: false, canvas: false, preview: true },
    voiceId: "voice-1", introVideo: "intros/impact.mp4", portedFrom: { slug: "impact-check", version: 7 },
  });
  expect(pkg.notes.join(" ")).toMatch(/planner, question bank and résumé-claim tools are not used/);
  expect(pkg.notes.join(" ")).toMatch(/retention promise was removed/);
  expect(pkg.notes.join(" ")).toMatch(/no longer enforced as required/);
});

test("a technical interview carries its question mix and topics, and switches on matching workspace tools", () => {
  const pkg = interviewSkillPackage(technicalInterview);
  expect(pkg.skill).toContain("Main questions: 1 multiple-choice, 2 coding, 2 verbal.");
  expect(pkg.skill).toContain("Draw questions only from these topics: closures, event-loop.");
  expect(pkg.skill).toContain("Up to 3 follow-up questions per main question");
  expect(pkg.skill).not.toContain("## Résumé");
  expect(pkg.settings.before).toBeUndefined();
  expect(pkg.settings.tools).toEqual({ codeEditor: true, choice: true, canvas: false, preview: false });
});

test("multi-stage and topic-less interviews keep every stage in order and say what differs", () => {
  const multi = interviewSkillPackage({
    ...technicalInterview, slug: "full-mock",
    data: { ...technicalInterview.data, config: { interview: { type: "technical", topic_slugs: [], question_counts: { "system-design": 1 } } },
      stages: ["resume", "technical", "feedback"].map((id) => ({ id, name: id.toUpperCase(), objective: `${id} goal` })) },
  });
  expect(multi.scenario.steps.map((s) => s.id)).toEqual(["resume", "technical", "feedback"]);
  expect(multi.skill.indexOf("`resume`")).toBeLessThan(multi.skill.indexOf("`technical`"));
  expect(multi.skill.indexOf("`technical`")).toBeLessThan(multi.skill.indexOf("`feedback`"));
  expect(multi.settings.tools.canvas).toBe(true);
  expect(multi.notes.join(" ")).toMatch(/No topics are selected/);
  expect(multi.notes.join(" ")).toMatch(/Multi-stage/);
});

test("the same agent always renders the same package (idempotent publication), and a change renders a new one", () => {
  expect(interviewSkillPackage(resumeInterview).skill).toBe(interviewSkillPackage(resumeInterview).skill);
  const edited = { ...resumeInterview, data: { ...resumeInterview.data, instruction: "Challenge every number twice." } };
  expect(interviewSkillPackage(edited).skill).not.toBe(interviewSkillPackage(resumeInterview).skill);
});

test("refuses agents that already run a skill or have no stages", () => {
  expect(() => interviewSkillPackage({ ...technicalInterview, data: { ...technicalInterview.data, skill: "# x" } })).toThrow(/already runs a skill/);
  expect(() => interviewSkillPackage({ ...technicalInterview, data: { ...technicalInterview.data, stages: [] } })).toThrow(/no stages/);
});
