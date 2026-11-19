import type { BeforeSettings } from "@/lib/context-upload";
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
  settings: { before?: BeforeSettings; tools: ToolSettings; voiceId?: string; introVideo?: string; portedFrom: { slug: string; version: number } };
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

export function interviewSkillPackage(agent: InterviewAgent): InterviewSkillPackage {
  const d = asRecord(agent.data);
  if (typeof d.skill === "string" && d.skill.trim()) throw new Error(`${agent.slug} already runs a skill`);
  const config = asRecord(d.config);
  const interview = asRecord(config.interview);
  const context = asRecord(config.context);
  const rendering = asRecord(config.rendering);
  const stages = (Array.isArray(d.stages) ? d.stages : []).map(asRecord);
  if (!stages.length) throw new Error(`${agent.slug} has no stages`);
  const notes: string[] = [
    "Runs as an authored skill role play: the legacy interview planner, question bank and résumé-claim tools are not used.",
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

  const plan: string[] = [];
  if (type === "resume") {
    plan.push(`- Interview type: résumé. Ask ${interview.main_questions ?? "a few"} main questions, each about a different claim from the candidate's résumé.`);
  } else if (type === "technical") {
    const mix = Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0).map(([kind, n]) => `${n} ${QUESTION_LABELS[kind] ?? kind}`);
    plan.push(`- Interview type: technical. Main questions: ${mix.join(", ") || "as the stages require"}.`);
    if (topics.length) plan.push(`- Draw questions only from these topics: ${topics.join(", ")}.`);
    else notes.push("No topics are selected; the interviewer chooses topics from the stage goals.");
  }
  if (followUps !== undefined) plan.push(`- Up to ${followUps} follow-up ${followUps === 1 ? "question" : "questions"} per main question before moving on.`);
  if (typeof maxTurns === "number") plan.push(`- The whole session is at most ${maxTurns} of your turns.`);

  const principles = strings(d.principles);
  const classifications = Object.entries(asRecord(d.classifications)).map(([key, meaning]) => [key, text(meaning)] as const).filter(([, m]) => m);
  const statuses = strings(asRecord(config.evidence).statuses);
  const grounding = (Array.isArray(d.knowledge_grounding) ? d.knowledge_grounding : []).map(asRecord);
  const maxWords = typeof rendering.maximum_words === "number" ? rendering.maximum_words : undefined;

  const steps = stages.map((stage, index) => {
    const id = kebab(text(stage.id) || `stage-${index + 1}`) || `stage-${index + 1}`;
    const stageConfig = asRecord(stage.config);
    const evidence = asRecord(stageConfig.evidence);
    const keys = strings(evidence.keys);
    const definitions = asRecord(evidence.definitions);
    const completion = new Set(strings(evidence.completion_keys));
    const turns = asRecord(stageConfig.turns);
    const moves = strings(asRecord(stageConfig.actions).allowed);
    const stageContext = asRecord(stageConfig.context);
    const lines = [
      `### \`${id}\` — ${text(stage.name) || id}`,
      "",
      `**Interviewer goal:** ${text(stage.objective) || text(stage.name) || objective}`,
    ];
    if (typeof turns.minimum === "number" || typeof turns.maximum === "number") {
      lines.push(`- Length: ${turns.minimum ?? 1}–${turns.maximum ?? turns.minimum} of your turns.`);
    }
    if (text(stage.opening)) lines.push(`- Open this stage with: ${text(stage.opening)}`);
    if (text(stage.stage_brief)) lines.push(`- Brief: ${text(stage.stage_brief)}`);
    if (text(stageContext.mode)) lines.push(`- Grounding: ${words(text(stageContext.mode))}${stageContext.required === true ? " (the résumé is required)" : ""}.`);
    if (text(stageConfig.claim_handling)) lines.push(`- Claims: ${words(text(stageConfig.claim_handling))}.`);
    if (keys.length) {
      lines.push("- Evidence to collect (★ = needed before this stage is complete):");
      for (const key of keys) lines.push(`  - ${completion.has(key) ? "★ " : ""}${words(key)}${text(definitions[key]) ? `: ${text(definitions[key])}` : ""}`);
    }
    if (moves.length) lines.push(`- Moves you may use: ${moves.map(words).join(", ")}.`);
    const tags = strings(asRecord(stageConfig.knowledge).tags);
    if (tags.length) lines.push(`- Knowledge focus: ${tags.join(", ")}.`);
    return { id, name: text(stage.name) || id, moves, block: lines.join("\n") };
  });

  const sections: string[] = [
    `# ${name}`,
    "",
    objective,
    "",
    "## Your role",
    "",
    `You are the interviewer. The learner is the candidate. Lead the conversation; never answer your own questions or speak for the candidate. Do not coach or give the answer during the interview.`,
  ];
  if (text(d.instruction)) sections.push("", text(d.instruction));
  if (principles.length) sections.push("", "## Principles", "", ...principles.map((p) => `- ${p}`));
  if (text(d.opening)) sections.push("", "## Opening", "", `Begin with: ${text(d.opening)}`);
  if (plan.length) sections.push("", "## Interview plan", "", ...plan);
  if (resumeMode || needsResume) {
    sections.push("", "## Résumé", "",
      `${needsResume ? "The candidate attaches a résumé before the session." : "The candidate may attach a résumé."} Use read_document to read it before referring to it. Quote only what it says; never invent claims. If no résumé is attached, ask the candidate to describe one project or achievement instead.`);
  }
  sections.push("", "## Steps", "", ...steps.flatMap((step) => [step.block, ""]));
  if (classifications.length) {
    sections.push("## Judging answers", "", "Classify each answer silently and choose your next move from it:", ...classifications.map(([key, meaning]) => `- ${words(key)}: ${meaning}`), "");
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
    `When the planned questions and their follow-ups are done${typeof maxTurns === "number" ? ` or you reach ${maxTurns} turns` : ""}, close with one short, consistent sentence that thanks the candidate and says the interview is complete, then end the call.`, "");

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
    name: `${name} (skill)`.slice(0, 200),
    description: objective.slice(0, 1024),
    trainer_role: "Interviewer",
    learner_role: "Candidate",
    steps: steps.map((step) => ({ id: step.id, name: step.name.slice(0, 200), trainer_moves: step.moves, learner_moves: [] })),
  });

  const label = text(context.label);
  const before: BeforeSettings | undefined = resumeMode || needsResume
    ? { preScreenshare: false, preUpload: true, duringUpload: false, uploadTitle: label || "Résumé", uploadInstruction: uploadPrompt(text(context.prompt)) }
    : undefined;
  if (needsResume) notes.push("The résumé upload is offered but no longer enforced as required (skill role plays have no required-upload setting).");
  if (before && text(context.prompt) && before.uploadInstruction !== text(context.prompt)) notes.push("The upload prompt's retention promise was removed pending a retention review.");

  const kinds = new Set(Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0).map(([kind]) => kind));
  const tools: ToolSettings = {
    codeEditor: kinds.has("coding") || kinds.has("code-output") || kinds.has("machine-coding") || stages.some((s) => strings(asRecord(asRecord(s.config).actions).allowed).includes("run_code")),
    choice: kinds.has("mcq"),
    canvas: kinds.has("system-design"),
    preview: resumeMode || needsResume,
  };
  if (agent.slug === "full-mock-interview" || stages.length > 1) notes.push("Multi-stage: the skill lists every stage in order; quotas are session-wide, not per stage.");

  return {
    scenario,
    skill,
    items: [],
    settings: {
      ...(before ? { before } : {}),
      tools,
      ...(text(d.voiceId) ? { voiceId: text(d.voiceId) } : {}),
      ...(text(d.introVideo) ? { introVideo: text(d.introVideo) } : {}),
      portedFrom: { slug: agent.slug, version: agent.version },
    },
    notes,
  };
}
