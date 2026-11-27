import { expect, test } from "bun:test";
import { interviewCharacter, interviewSkillPackage, questionItem } from "@/lib/interview-skill";
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
    scenario: "impact-check", name: "Impact Check", trainer_role: "Interviewer", learner_role: "Candidate",
    steps: [{ id: "impact-validation", name: "Impact Validation", trainer_moves: ["probe_required_evidence", "narrow_hint"], learner_moves: [] }],
  });
  // Authored text is carried verbatim.
  expect(pkg.skill).toContain("Challenge every number.\n\\- What was the baseline?");
  for (const line of ["- One question at a time.", "Begin with: Hi, let's look at one number on your résumé.", "4 main questions, each on a different claim",
    "Follow-ups: at most 2 per main question", "within about 12 of your turns", "★ baseline: Value before the change.", "  - causal link: Why the work caused it.",
    "Open this stage with (your first main question): Pick your strongest number.", "- strong: Fully explained.", "untested, partial, sufficient",
    "Focus on baseline and method.", "At most 45 words per turn. One focal ask per turn. At most 1 question mark per turn.",
    "surface open_pdf", "read_document", "surface highlight_document", "end_call({ outcome: \"completed\" })"]) {
    expect(pkg.skill).toContain(line);
  }
  // Runtime config labels are not prompt text; turn bounds no longer compete with the question counts.
  for (const gone of ["Length:", "Grounding:", "Claims:", "Moves you may use", "Knowledge focus"]) expect(pkg.skill).not.toContain(gone);
  expect(pkg.skill.startsWith("---\nname: \"Impact Check\"\n")).toBe(true);
  expect(pkg.skill).toContain('ported_from: "impact-check@v7"');
  // The step goal is readable the way the runtime reads authored skills.
  expect(stepGoal(skillBody(pkg.skill), "impact-validation")).toBe("Validate quantified claims.");
  expect(pkg.items).toEqual([]);
  // The legacy session rules become Settings-tab switches: screen share and a required résumé, as before.
  expect(pkg.settings.before).toEqual({ preScreenshare: true, preUpload: true, preUploadRequired: true, duringUpload: false, uploadTitle: "Documents", uploadInstruction: "Upload your résumé. Then we begin." });
  expect(pkg.settings.tools).toEqual({ codeEditor: false, choice: false, canvas: false, preview: true, knowledge: true });
  expect(pkg.settings).toMatchObject({ voiceId: "voice-1", introVideo: "intros/impact.mp4", portedFrom: { slug: "impact-check", version: 7 } });
  expect(pkg.settings.learnerBrief).toMatch(/A mock interview: Impact Check\. .*Attach your résumé/);
  // Stage evidence becomes the report rubric: required (★) items first and weighted double, 100 points in all.
  expect(pkg.settings.after.report).toBe("roleplay");
  expect(pkg.settings.after.rubric.map((r) => r.name)).toEqual(["baseline: Value before the change.", "causal link: Why the work caused it."]);
  expect(pkg.settings.after.rubric.reduce((sum, r) => sum + r.points, 0)).toBe(100);
  expect(pkg.settings.after.rubric[0].points).toBeGreaterThan(pkg.settings.after.rubric[1].points);
  expect(pkg.notes.join(" ")).toMatch(/question bank is copied into the role play's items/);
  expect(pkg.notes.join(" ")).toMatch(/retention promise was removed/);
});

test("a technical interview carries its question mix and topics, and switches on matching workspace tools", () => {
  const pkg = interviewSkillPackage(technicalInterview);
  // The legacy planner's order and exact counts.
  expect(pkg.skill).toContain("5 main questions, in this order: 2 verbal, then 1 multiple-choice, then 2 coding. Exactly these counts");
  expect(pkg.skill).toContain("Topics, only these: closures, event-loop.");
  expect(pkg.skill).toContain("Follow-ups: at most 3 per main question; after the last one, move to the next main question");
  expect(pkg.skill).toContain("When the question type changes, say so");
  // One flow per type used, naming the exact tools; types not used have none.
  expect(pkg.skill).toContain("**Verbal.**");
  expect(pkg.skill).toMatch(/\*\*Multiple choice\.\*\* surface open_choice .*code as \{ language, content \}.*never read the options.*get_choice_state.*isCorrect.*highlight_choice/);
  expect(pkg.skill).toMatch(/\*\*Coding\.\*\* surface open_code_editor .*readOnly: false.*read_code_range.*highlight_code/);
  expect(pkg.skill).not.toContain("**Code output.**");
  expect(pkg.skill).not.toContain("**System design.**");
  expect(pkg.skill).toContain("surface close_surface first");
  expect(pkg.skill).not.toContain("## Résumé");
  expect(pkg.settings.before).toMatchObject({ preUpload: false, preUploadRequired: false });
  expect(pkg.settings.tools).toEqual({ codeEditor: true, choice: true, canvas: false, preview: false, knowledge: false });
  // No questions given: the AI still states the problem first.
  expect(pkg.skill).toContain("State the exact problem before you ask for an answer.");
});

test("bank questions become searchable items and the skill says to state the problem first; system design opens the whiteboard", () => {
  const questions = [
    { id: "q1", text: "Design a news feed.", spokenText: "Design a news feed system.", questionType: "system-design", difficulty: "hard", topicSlugs: ["system-design"], keyPoints: ["fan-out", "pagination"] },
    { id: "q2", text: "What prints?", questionType: "code-output", code: { language: "js", content: "console.log(1)" } },
  ];
  // An MCQ item carries its bank answer key for open_choice's correctOptionId.
  const mcq = questionItem({ id: "q3", text: "Given the code shown above, what is logged?", questionType: "mcq", code: { language: "javascript", content: "console.log('A')" }, options: [{ id: "A", text: "A" }, { id: "B", text: "B" }], correctOptionId: "A" });
  expect(mcq.context).toContain("Correct option (for you only; pass it as correctOptionId, never say it): A");
  expect(mcq.text).toContain("Code (javascript):\nconsole.log('A')");
  const pkg = interviewSkillPackage({ ...technicalInterview, data: { ...technicalInterview.data, config: { interview: { type: "technical", topic_slugs: ["system-design"], question_counts: { "system-design": 1 } } } } }, { questions });
  // Only questions of the interview's types are kept.
  expect(pkg.items).toHaveLength(1);
  expect(pkg.items[0]).toMatchObject({ id: expect.stringMatching(/^question-[0-9a-f]{16}$/), role: "trainer", metadata: { kind: "question", source: "question-bank" } });
  expect(pkg.items[0].text).toContain("Say it as: Design a news feed system.");
  expect(pkg.items[0].context).toMatch(/system-design question\. hard difficulty\. topics: system-design\. What a strong answer covers \(for you only; never say it\): fan-out; pagination/);
  expect(pkg.skill).toContain("1 main question, in this order: 1 system-design.");
  expect(pkg.skill).toContain("scenario_examples({ situation:");
  expect(pkg.skill).toContain("ask it as written");
  expect(pkg.skill).toMatch(/\*\*System design\.\*\* surface open_whiteboard \{ questionId, question \}.*read_canvas_scene.*at least two follow-ups.*highlight_whiteboard/);
  expect(pkg.settings.tools.canvas).toBe(true);
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

test("code-output keeps its one reveal; the interviewer character carries identity only", () => {
  const pkg = interviewSkillPackage({ ...technicalInterview, data: { ...technicalInterview.data, config: { interview: { type: "technical", topic_slugs: ["closures"], question_counts: { "code-output": 1 }, follow_ups_per_main_question: 1 } } } });
  expect(pkg.skill).toMatch(/\*\*Code output\.\*\* surface open_code_editor .*readOnly: true.*Now run it.*highlight_code.*the only answer you ever reveal/);
  expect(pkg.skill).toContain("One exception: the code-output reveal above.");
  const character = interviewCharacter({ personaName: "Asha", interviewName: "Concepts", objective: "Probe conceptual understanding" });
  expect(character).toContain('You are Asha, interviewing the candidate in "Concepts": Probe conceptual understanding.');
  for (const procedure of ["surface", "highlight", "end_call", "main questions"]) expect(character).not.toContain(procedure);
  // A trainer's own character template (from their recorded interviews) fills in only the interview's name and goal.
  const vasanth = interviewCharacter({ personaName: "Vasanth", interviewName: "Concepts", objective: "Probe conceptual understanding", template: "In \"{{interview}}\": {{objective}} Close: \"Nice talking to you, <their name>.\"" });
  expect(vasanth).toBe('In "Concepts": Probe conceptual understanding. Close: "Nice talking to you, <their name>."\n');
});

test("refuses agents that already run a skill or have no stages", () => {
  expect(() => interviewSkillPackage({ ...technicalInterview, data: { ...technicalInterview.data, skill: "# x" } })).toThrow(/already runs a skill/);
  expect(() => interviewSkillPackage({ ...technicalInterview, data: { ...technicalInterview.data, stages: [] } })).toThrow(/no stages/);
});
