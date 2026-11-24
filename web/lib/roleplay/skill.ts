import { z } from "zod";

/**
 * During, for a role play: the builder's fields rendered into the same package a twin skill is (SKILL.md +
 * scenario.json + items.json), plus the After block (goals, rubric) the AI never sees. Deterministic, no LLM.
 * The package is the stage, the same for every persona: who the client is on this call (facts, what they hide, opening
 * line, how they talk and react, which ending they accept) is each persona's character (AgentPersona.character).
 * The builder input is the source (decision D1, plans/roleplay-skill.md): it is kept in `scenario.json.roleplay`
 * (goals and rubric in `after`), so editing reads back exactly what was saved and SKILL.md / items are regenerated.
 * Client-safe: no server imports.
 */

export const DIFFICULTIES = [
  { value: "easy", label: "Easy", description: "Nervous but willing. Opens up quickly once the learner asks a good question." },
  { value: "medium", label: "Medium", description: "Guarded at first. Opens up only when the learner earns it." },
  { value: "hard", label: "Hard", description: "Confident and testing. Impatient with weak or scripted questions." },
  { value: "hardest", label: "Hardest", description: "Hides the real issue. Ends the call quickly after mistakes." },
] as const;
export type Difficulty = (typeof DIFFICULTIES)[number]["value"];

export const MAX_GOALS = 5;
export const MAX_RUBRIC_CRITERIA = 8;
export const MAX_EXAMPLE_LINES = 20;

const line = z.string().trim().min(1).max(300);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case");

/** The role-play builder's fields (Before lives in data.before and is edited separately). */
export const roleplayBuilderSchema = z.object({
  name: z.string().trim().min(1, "Add a name").max(120),
  /** The client: a persona of the org (Persona Library). */
  persona: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "Choose who the learner will speak with"),
  situation: z.object({
    /** What is happening, the same for every persona that plays it. */
    scenario: z.string().trim().min(1, "Describe the situation").max(4000),
    learnerRole: z.string().trim().min(1, "Say who the learner plays").max(100),
  }),
  difficulty: z.enum(DIFFICULTIES.map((d) => d.value) as [Difficulty, ...Difficulty[]]),
  /** The learner's brief, shown before the call. */
  whatToExpect: optionalText(1000),
  /** Lines a client might say (objections, brush-offs): items.json, shared by every persona. May be empty. */
  exampleLines: z.array(line).max(MAX_EXAMPLE_LINES).default([]),
  learnerGoals: z.array(line).min(1, "Add at least one learner goal").max(MAX_GOALS, `${MAX_GOALS} learner goals at most`),
  rubric: z.array(z.object({
    name: z.string().trim().min(1, "Name every rubric score").max(120),
    points: z.number().int().min(1).max(100),
  })).min(1, "Add at least one rubric score").max(MAX_RUBRIC_CRITERIA, `${MAX_RUBRIC_CRITERIA} rubric scores at most`),
});
export type RoleplayBuilder = z.infer<typeof roleplayBuilderSchema>;

/** One line of a role play's items.json: the client's side or the learner's (twin items use trainer / learner). */
export const roleplayItemSchema = z.looseObject({
  id: z.string().min(1).max(300),
  role: z.enum(["client", "learner"]),
  context: z.string().max(2000),
  text: z.string().min(1).max(8000),
  metadata: z.looseObject({ step: z.string().max(100).optional(), move: z.string().max(100).optional(), kind: z.string().max(40).optional() }),
});
export type RoleplayItem = z.infer<typeof roleplayItemSchema>;

/** The call's steps; `trainer_moves` are the AI client's moves (the manifest's field names are shared with twins). */
const STEPS = [
  { id: "opening", name: "The client answers", trainer_moves: ["answer_call"], learner_moves: ["introduce", "give_reason_for_call"] },
  { id: "objection", name: "The client pushes back", trainer_moves: ["raise_objection", "push_back", "open_up", "reveal"], learner_moves: ["acknowledge", "ask_question", "uncover_reason", "offer_value"] },
  { id: "close", name: "The call ends", trainer_moves: ["agree_next_step", "decline"], learner_moves: ["propose_next_step"] },
];

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

/** SKILL.md: the stage every persona plays. Never contains the goals or the rubric (After), nor any one persona. */
function renderSkillMarkdown(slug: string, input: RoleplayBuilder, description: string): string {
  const s = input.situation;
  const who = [
    // Persona-neutral: each persona of the pool plays it under its own name, as its CHARACTER says (specs/agents.md).
    "You are the persona described in PERSONA, as your CHARACTER for this role play describes you.",
    `The person talking to you plays: ${s.learnerRole}. They are practising on you. Stay in character for the whole call.`,
  ].join("\n");
  const sections = [
    `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---`,
    `# ${input.name}`,
    `## Who you are on this call\n${who}`,
    `## Situation\n${s.scenario}`,
    `## How the call can end\n${bullets([
      "Agree or decline as your character says.",
      "Never agree to buy, reserve or pay anything on this call.",
    ])}`,
    `## Steps\n### 1. ${STEPS[0].name} \`opening\`\nAnswer the call with your character's opening line.\n### 2. ${STEPS[1].name} \`objection\`\nHold your surface objection. React to what they do as your character says.\n### 3. ${STEPS[2].name} \`close\`\nEnd the call as in How the call can end.`,
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/**
 * The role play's files and Agent.data blocks from the builder. `clientRole` is the persona's role (e.g. Buyer),
 * the manifest's trainer_role.
 */
export function renderRoleplay(slug: string, builder: RoleplayBuilder, clientRole = "Client") {
  const input = roleplayBuilderSchema.parse(builder);
  if (!kebab.safeParse(slug).success) throw new Error(`"${slug}" is not a kebab-case id`);
  const description = (input.whatToExpect || `${input.name}: practise a call with a ${clientRole.toLowerCase()}.`).slice(0, 1024);
  const { learnerGoals, rubric, ...during } = input;
  const scenario = {
    scenario: slug,
    name: input.name,
    description,
    trainer_role: clientRole,
    learner_role: input.situation.learnerRole,
    difficulty: input.difficulty,
    steps: STEPS,
    roleplay: during,
  };
  const items: RoleplayItem[] = input.exampleLines.map((text, index) => ({ id: `${slug}-line-${index + 1}`, role: "client" as const, context: "", text, metadata: { kind: "example" } }));
  return {
    skill: renderSkillMarkdown(slug, input, description),
    scenario,
    items,
    after: { report: "roleplay" as const, goals: learnerGoals, rubric },
  };
}

/** The builder's fields back from a stored role play (scenario.json.roleplay + after), or null if it has none. */
export function roleplayBuilderFrom(data: unknown): RoleplayBuilder | null {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const during = record(record(record(data).scenario).roleplay);
  const after = record(record(data).after);
  const parsed = roleplayBuilderSchema.safeParse({ ...during, learnerGoals: after.goals, rubric: after.rubric });
  return parsed.success ? parsed.data : null;
}
