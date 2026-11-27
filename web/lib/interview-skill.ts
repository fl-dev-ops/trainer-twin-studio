import { createHash } from "node:crypto";
import { contextUploadFromAgentData, type BeforeSettings } from "@/lib/context-upload";
import type { ToolSettings } from "@/lib/agent-tools";
import { scenarioManifestSchema, type ScenarioItem, type ScenarioManifest } from "@/lib/scenario-ingest";

/**
 * Ports an interviewer-led role play (an older no-skill `ROLEPLAY` agent, e.g. Vasanth's interviews) into an
 * authored skill package: SKILL.md + scenario.json + items.json, published through the shared skill publisher as a
 * NEW role play next to the original. The original agent, its history and sessions are never changed.
 *
 * What carries over, verbatim where it is authored text: instruction, principles, opening, stages (goal, turn bounds,
 * opening, evidence keys/definitions, completion keys, allowed moves), interview plan (type, quotas, follow-ups,
 * topics), answer classifications, evidence statuses, rendering rules, knowledge guidance and the résumé upload.
 * What does not: the legacy interview planner, question bank and résumé-claim tools (skill sessions run the
 * authored procedure, see chat/agent/lib/roleplay.ts). `notes` lists every such difference for the operator.
 */

export type InterviewAgent = { slug: string; name: string; version: number; data: unknown };
export type InterviewSkillPackage = {
  scenario: ScenarioManifest;
  skill: string;
  items: ScenarioItem[];
  /** Agent.data settings published alongside the package (not package content). */
  settings: { before: BeforeSettings; tools: ToolSettings; after: { report: "roleplay"; goals: string[]; rubric: { name: string; points: number }[] }; learnerBrief: string; voiceId?: string; introVideo?: string; portedFrom: { slug: string; version: number } };
  notes: string[];
};

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
const kebab = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const words = (value: string) => value.replace(/_/g, " ");
/** One line of YAML header text: no line breaks, quoted. */
const yaml = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());

/** Which upload prompt sentences are kept: a retention promise needs its own review, so it is not repeated. */
function uploadPrompt(prompt: string) {
  return prompt.split(/(?<=[.!?])\s+/).filter((sentence) => !/\bdelet/i.test(sentence)).join(" ").trim();
}

const QUESTION_LABELS: Record<string, string> = {
  verbal: "verbal", mcq: "multiple-choice", coding: "coding", "code-output": "code-output", "system-design": "system-design", "machine-coding": "machine-coding",
};

/** The legacy planner's question order (chat session_plan QUESTION_TYPES). */
const QUESTION_ORDER = ["verbal", "mcq", "coding", "code-output", "machine-coding", "system-design"] as const;

/**
 * How each question type the interview uses runs, step by step, with the exact workspace calls (the same names and
 * payloads as the tool descriptions, chat/agent/tools/workspace.ts). These were enforced by the legacy runtime's
 * prompt and planner; a skill role play has only this text.
 */
function questionFlows(kinds: Set<string>, { resume }: { resume: boolean }): string[] {
  const flows: string[] = [];
  if (kinds.has("verbal")) {
    flows.push("**Verbal.** Ask it and let them think (up to three minutes). Silent for about thirty seconds: \"Any thoughts so far?\"; still stuck: one narrow nudge.");
  }
  if (kinds.has("mcq")) {
    flows.push("**Multiple choice.** surface open_choice { questionId, question, options, correctOptionId, code }; the question's code goes in code as { language, content }, or the learner sees no code. Say one line (\"One on your screen, pick an answer.\"); never read the options. When they pick or speak, get_choice_state and trust isCorrect. Right: ask why, if a follow-up is left. Wrong: highlight_choice their pick and ask one question that tests it, without naming the right option. Then move on.");
  }
  if (kinds.has("coding") || kinds.has("machine-coding")) {
    flows.push(`**Coding${kinds.has("machine-coding") ? " and machine coding" : ""}.** surface open_code_editor { questionId, question, language, starterCode: "", readOnly: false } and state the problem. Let them write; don't interrupt. Stuck or asking for help: read_code_range 1 to 200; if there is real code, highlight_code the lines that matter and ask one question about "the highlighted lines" that points to the next step, never giving code; if not, ask one question about the first step. Done: ask them to walk you through it${kinds.has("machine-coding") ? " (for machine coding: structure, state and data flow, trade-offs)" : ""}, then at most one follow-up on complexity, an edge case or a decision, highlighting the lines it is about.`);
  }
  if (kinds.has("code-output")) {
    flows.push("**Code output.** surface open_code_editor { questionId, question, language, starterCode: <the snippet>, readOnly: true }; ask what it prints and why. Once they predict: \"Now run it and tell me what you get.\" Right and explained: move on. Wrong, unexplained or stuck: read_code_range 1 to 200, highlight_code the line that decides the output, and ask one question about \"the highlighted line\". Still wrong: give the output and why in two sentences (the only answer you ever reveal), then move on.");
  }
  if (kinds.has("system-design")) {
    flows.push("**System design.** surface open_whiteboard { questionId, question } and ask them to sketch the main components and how data flows. Only when they say they drew or changed it: read_canvas_scene. A diagram for a different problem: say so and steer back; never discuss or highlight it. Then at least two follow-ups, each: highlight_whiteboard one label they wrote, tied to a gap (a bottleneck, failure, scale or trade-off), and ask about \"the highlighted <label>\". The second builds on their last answer.");
  }
  if (flows.length > 1 || (flows.length && resume)) flows.push("Leaving a screen question for a verbal or résumé one: surface close_surface first.");
  return flows;
}

/** Questions from the org's question bank the port writes into the skill (the legacy runtime picked them live). */
export type BankQuestion = {
  id: string; text: string; spokenText?: string; questionType: string; difficulty?: string; topicSlugs?: string[];
  code?: { language: string; content: string }; options?: { id: string; text: string }[]; correctOptionId?: string; keyPoints?: string[];
};

/** A bank question as a role-play item the AI looks up with scenario_examples (its side, "trainer"). */
export function questionItem(q: BankQuestion): ScenarioItem {
  const body = [
    q.spokenText && q.spokenText !== q.text ? `${q.text}\n\nSay it as: ${q.spokenText}` : q.text,
    q.code ? `Code (${q.code.language}):\n${q.code.content}` : "",
    q.options?.length ? `Options:\n${q.options.map((o) => `${o.id}) ${o.text}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const context = [
    `${QUESTION_LABELS[q.questionType] ?? q.questionType} question`,
    q.difficulty ? `${q.difficulty} difficulty` : "",
    q.topicSlugs?.length ? `topics: ${q.topicSlugs.join(", ")}` : "",
    // The bank's answer key: open_choice needs it as correctOptionId, so get_choice_state grades against the bank.
    q.correctOptionId ? `Correct option (for you only; pass it as correctOptionId, never say it): ${q.correctOptionId}` : "",
    q.keyPoints?.length ? `What a strong answer covers (for you only; never say it): ${q.keyPoints.join("; ")}` : "",
  ].filter(Boolean).join(". ");
  // Short, stable ids: the vector store caps ids (with their scope prefix) at 128 bytes.
  return { id: `question-${createHash("sha256").update(q.id).digest("hex").slice(0, 16)}`, role: "trainer", context: context.slice(0, 2000), text: body.slice(0, 8000), metadata: { kind: "question", source: "question-bank" } };
}

export function interviewSkillPackage(agent: InterviewAgent, options: { questions?: BankQuestion[] } = {}): InterviewSkillPackage {
  const d = asRecord(agent.data);
  if (typeof d.skill === "string" && d.skill.trim()) throw new Error(`${agent.slug} already runs a skill`);
  const config = asRecord(d.config);
  const interview = asRecord(config.interview);
  const context = asRecord(config.context);
  const rendering = asRecord(config.rendering);
  const stages = (Array.isArray(d.stages) ? d.stages : []).map(asRecord);
  if (!stages.length) throw new Error(`${agent.slug} has no stages`);
  const notes: string[] = [
    "Runs as an authored skill role play: the question bank is copied into the role play's items; the legacy planner and résumé-claim tools are not used (the AI reads the résumé with read_document).",
  ];

  const name = text(d.name) || agent.name;
  const objective = text(d.objective) || `Practice interview: ${name}`;
  const type = text(interview.type);
  const followUps = typeof interview.follow_ups_per_main_question === "number" ? interview.follow_ups_per_main_question : undefined;
  const counts = asRecord(interview.question_counts);
  const topics = strings(interview.topic_slugs);
  const maxTurns = asRecord(config.turns).maximum;
  const resumeMode = /resume/.test(text(context.mode)) || stages.some((s) => /resume/.test(text(asRecord(asRecord(s.config).context).mode)));
  const needsResume = context.required === true || stages.some((s) => asRecord(asRecord(s.config).context).required === true);

  const kinds = new Set(Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0).map(([kind]) => kind));
  const questions = (options.questions ?? []).filter((q) => !kinds.size || kinds.has(q.questionType));
  // The legacy planner's order (chat session_plan): talk first, then the screen-based types.
  const ordered = QUESTION_ORDER.filter((kind) => kinds.has(kind)).map((kind) => [kind, counts[kind] as number] as const);
  const total = ordered.reduce((sum, [, n]) => sum + n, 0);

  const plan: string[] = [];
  if (type === "resume") {
    plan.push(`- ${interview.main_questions ?? "A few"} main questions, each on a different claim from the candidate's résumé. Never add one.`);
  } else if (type === "technical") {
    plan.push(ordered.length
      ? `- ${total} main question${total === 1 ? "" : "s"}, in this order: ${ordered.map(([kind, n]) => `${n} ${QUESTION_LABELS[kind] ?? kind}`).join(", then ")}. Exactly these counts: never add, swap or skip a type. Keep count silently.`
      : "- Main questions as the stage goals require.");
    if (topics.length) plan.push(`- Topics, only these: ${topics.join(", ")}. Vary them across questions.`);
    else notes.push("No topics are selected; the interviewer chooses topics from the stage goals.");
    plan.push(questions.length
      ? "- Each main question comes from the bank: scenario_examples({ situation: \"<type> question about <topic>\" }), pick one you have not asked, and ask it as written (its code and options included). Its context says what a strong answer covers: steer follow-ups with it, never say it."
      : "- Write each main question yourself from the topics. State the exact problem before you ask for an answer.");
  }
  if (followUps !== undefined) {
    plan.push(`- Follow-ups: at most ${followUps} per main question; after the last one, move to the next main question even if the answer is still thin${kinds.has("system-design") ? " (system design: at least two, see below)" : ""}. A probe, hint${type === "technical" ? ", recovery" : ""} or highlighted question each uses one; ${type === "technical" ? "instructions (\"run it\", \"walk me through it\") and " : ""}silence nudges don't.`);
  }
  if (ordered.length > 1) plan.push("- When the question type changes, say so in a few words (\"Let's do a coding one now.\"). Before each new main question, one short bridge from their last answer; never a generic \"great\".");
  if (typeof maxTurns === "number") plan.push(`- Aim to finish within about ${maxTurns} of your turns; the counts above come first.`);

  const principles = strings(d.principles);
  const classifications = Object.entries(asRecord(d.classifications)).map(([key, meaning]) => [key, text(meaning)] as const).filter(([, m]) => m);
  const statuses = strings(asRecord(config.evidence).statuses);
  const grounding = (Array.isArray(d.knowledge_grounding) ? d.knowledge_grounding : []).map(asRecord);
  const maxWords = typeof rendering.maximum_words === "number" ? rendering.maximum_words : undefined;

  // Report rubric: the stages' evidence items (★ required ones first, weighted double), at most 8, points summing to 100.
  const evidenceRows = stages.flatMap((stage) => {
    const evidence = asRecord(asRecord(stage.config).evidence);
    const definitions = asRecord(evidence.definitions);
    const required = new Set(strings(evidence.completion_keys));
    return strings(evidence.keys).map((key) => ({ name: `${words(key)}${text(definitions[key]) ? `: ${text(definitions[key])}` : ""}`.slice(0, 200), weight: required.has(key) ? 2 : 1 }));
  });
  const picked = [...evidenceRows].sort((a, b) => b.weight - a.weight).filter((row, i, all) => all.findIndex((r) => r.name === row.name) === i).slice(0, 8);
  const totalWeight = picked.reduce((sum, row) => sum + row.weight, 0);
  const rubric = picked.map((row) => ({ name: row.name, points: Math.max(1, Math.floor((100 * row.weight) / totalWeight)) }));
  if (rubric.length) rubric[0].points += 100 - rubric.reduce((sum, row) => sum + row.points, 0);

  const steps = stages.map((stage, index) => {
    const id = kebab(text(stage.id) || `stage-${index + 1}`) || `stage-${index + 1}`;
    const stageConfig = asRecord(stage.config);
    const evidence = asRecord(stageConfig.evidence);
    const keys = strings(evidence.keys);
    const definitions = asRecord(evidence.definitions);
    const completion = new Set(strings(evidence.completion_keys));
    const moves = strings(asRecord(stageConfig.actions).allowed);
    const lines = [
      `### \`${id}\` — ${text(stage.name) || id}`,
      "",
      `**Interviewer goal:** ${text(stage.objective) || text(stage.name) || objective}`,
    ];
    // Stage turn bounds are not carried: the question counts and follow-ups decide the length, as the legacy planner did.
    // Only what the model can act on: the legacy grounding/claim labels, action names and knowledge tags were runtime
    // config (the flows above now say how each question runs) and stay in the manifest, not the text.
    if (text(stage.opening)) lines.push(`- Open this stage with${stages.length === 1 ? " (your first main question)" : ""}: ${text(stage.opening)}`);
    if (text(stage.stage_brief)) lines.push(`- Brief: ${text(stage.stage_brief)}`);
    if (keys.length) {
      lines.push("- Evidence to collect (★ = needed before this stage is complete):");
      for (const key of keys) lines.push(`  - ${completion.has(key) ? "★ " : ""}${words(key)}${text(definitions[key]) ? `: ${text(definitions[key])}` : ""}`);
    }
    return { id, name: text(stage.name) || id, moves, block: lines.join("\n") };
  });

  const sections: string[] = [
    `# ${name}`,
    "",
    objective,
    "",
    "## Your role",
    "",
    "You are the interviewer; the learner is the candidate. You lead: one focused question per turn. Never answer for them, coach or teach during the interview.",
  ];
  if (text(d.instruction)) sections.push("", text(d.instruction));
  if (principles.length) sections.push("", "## Principles", "", ...principles.map((p) => `- ${p}`));
  if (text(d.opening)) sections.push("", "## Opening", "", `Begin with: ${text(d.opening)}`);
  if (plan.length) sections.push("", "## Plan", "", ...plan);
  const flows = questionFlows(kinds, { resume: type === "resume" });
  if (flows.length) sections.push("", "## How each question runs", "", ...flows);
  if (resumeMode || needsResume) {
    sections.push("", "## Résumé", "", type === "resume"
      ? `${needsResume ? "The candidate attaches a résumé before the session." : "The candidate may attach a résumé."} On your opening turn open it (surface open_pdf) and read it (read_document). For each main question pick one new claim (a project, role, impact, architecture or technology), highlight its exact words (surface highlight_document), then ask about "the highlighted line". Follow-ups stay on that claim. Quote only what it says. If their answers contradict it, ask once, neutrally: "Your résumé says X, but you said Y. Which is current?" No résumé: ask them to describe one project instead.`
      : "The candidate may attach a résumé; read it (read_document) before you refer to it, quote only what it says, and never make it the topic of a technical question.");
  }
  sections.push("", "## Steps", "", ...steps.flatMap((step) => [step.block, ""]));
  sections.push("## Answers", "",
    `- While a question is open, never give, confirm or hint the answer, and never teach.${kinds.has("code-output") ? " One exception: the code-output reveal above." : ""} At most one narrow hint that does not contain it.`,
    "- A wrong answer: make their claim concrete and ask one neutral question that tests it. Don't correct them.",
    "- \"I don't know\": say \"That's okay.\" and ask once from a different angle. A second \"I don't know\" closes the question in one line (you may name the topic to revise); go to the next.",
    "");
  if (classifications.length) {
    sections.push("Classify each answer silently and choose your next move from it:", ...classifications.map(([key, meaning]) => `- ${words(key)}: ${meaning}`), "");
  }
  if (statuses.length) sections.push("## Evidence status", "", `Track each evidence item silently as one of: ${statuses.join(", ")}. Probe what is not yet sufficient before moving on.`, "");
  if (grounding.length) {
    sections.push("## Knowledge", "", ...grounding.map((g) => `- ${text(g.queryGuidance) || text(g.purpose)}`).filter((line) => line !== "- "), "");
  }
  const speaking = [
    maxWords ? `At most ${maxWords} words per turn.` : null,
    rendering.one_focal_ask === true ? "One focal ask per turn." : null,
    typeof rendering.maximum_question_marks === "number" ? `At most ${rendering.maximum_question_marks} question mark per turn.` : null,
  ].filter(Boolean);
  sections.push("## How you speak", "", ...(speaking.length ? [`- ${speaking.join(" ")}`] : []),
    "- Natural spoken sentences; no lists, markdown or emojis.", "");
  sections.push("## Ending", "",
    "When the last main question and its follow-ups are done, ask once whether they have a question for you and answer it briefly. Then, in one reply, say your closing line (your character's; else \"Thanks, <their name>. That's the end of our interview.\") and only after those words call end_call({ outcome: \"completed\" }); never call it silently. If they leave early, say goodbye and call end_call.", "");

  const skill = [
    "---",
    `name: ${yaml(name)}`,
    `description: ${yaml(objective.slice(0, 1000))}`,
    `ported_from: ${yaml(`${agent.slug}@v${agent.version}`)}`,
    "---",
    "",
    sections.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    "",
  ].join("\n");

  const scenario = scenarioManifestSchema.parse({
    scenario: kebab(agent.slug),
    name: name.slice(0, 200),
    description: objective.slice(0, 1024),
    trainer_role: "Interviewer",
    learner_role: "Candidate",
    steps: steps.map((step) => ({ id: step.id, name: step.name.slice(0, 200), trainer_moves: step.moves, learner_moves: [] })),
  });

  const label = text(context.label);
  // What the session asked for before: the legacy rules (screen share, résumé upload), now as Settings-tab switches.
  const legacy = contextUploadFromAgentData(d, "ROLEPLAY");
  const before: BeforeSettings = {
    preScreenshare: legacy.screenShare,
    preUpload: legacy.offered || resumeMode || needsResume,
    preUploadRequired: legacy.required || needsResume,
    duringUpload: legacy.duringSession,
    uploadTitle: label || (resumeMode || needsResume ? "Résumé" : ""),
    uploadInstruction: uploadPrompt(text(context.prompt)),
  };
  if (before && text(context.prompt) && before.uploadInstruction !== text(context.prompt)) notes.push("The upload prompt's retention promise was removed pending a retention review.");

  const tools: ToolSettings = {
    codeEditor: kinds.has("coding") || kinds.has("code-output") || kinds.has("machine-coding") || stages.some((s) => strings(asRecord(asRecord(s.config).actions).allowed).includes("run_code")),
    choice: kinds.has("mcq"),
    canvas: kinds.has("system-design"),
    preview: resumeMode || needsResume,
    knowledge: grounding.length > 0 || strings(d.knowledge_bases).length > 0 || Boolean(text(d.knowledgeBase)),
  };
  if (agent.slug === "full-mock-interview" || stages.length > 1) notes.push("Multi-stage: the skill lists every stage in order; quotas are session-wide, not per stage.");

  return {
    scenario,
    skill,
    items: questions.map(questionItem),
    settings: {
      before,
      tools,
      ...(text(d.voiceId) ? { voiceId: text(d.voiceId) } : {}),
      ...(text(d.introVideo) ? { introVideo: text(d.introVideo) } : {}),
      portedFrom: { slug: agent.slug, version: agent.version },
      after: { report: "roleplay", goals: [], rubric },
      learnerBrief: [
        `A mock interview: ${name}. You are the candidate; answer as you would in a real interview.`,
        questions.length ? "The interviewer will give you a problem to work through; think out loud." : "",
        needsResume ? "Attach your résumé before you start; the questions come from it." : resumeMode ? "You can attach your résumé before you start." : "",
      ].filter(Boolean).join(" "),
    },
    notes,
  };
}

/**
 * The interviewer's character for a ported interview (AgentPersona.character): who the persona is on this call and
 * how they come across. Procedure (questions, tools, ending) stays in the stage; voice and habits stay in the persona.
 */
export function interviewCharacter(input: { personaName: string; interviewName: string; objective: string; template?: string }): string {
  const objective = input.objective.replace(/\s+/g, " ").trim().replace(/\.?$/, ".");
  // A trainer-specific character (web/data/roleplay/characters/*.md, written from their recorded interviews).
  if (input.template) return input.template.replaceAll("{{interview}}", input.interviewName).replaceAll("{{objective}}", objective).trim() + "\n";
  return [
    "## Who you are here",
    "",
    `You are ${input.personaName}, interviewing the candidate in "${input.interviewName}": ${objective} You have run many of these and want to see how they think, not what they memorised.`,
    "",
    "## How you come across",
    "",
    "- Calm and warm, never a quiz-master. A nervous or stuck candidate gets one line of reassurance, then the question again.",
    "- Acknowledge by naming what they said (\"Right, the microtask queue.\"), not with praise.",
    "- Your feedback comes after the interview, never during it.",
    "",
  ].join("\n");
}
