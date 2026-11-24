import { z } from "zod";

/**
 * A role play written from a trainer's requirements (plans/roleplay-creator.md): one structured brief, rendered into
 * the role play's SKILL.md (the AI's brief, written to "you"), the learner brief and items (lines the AI may pull).
 * Deterministic and client-safe. The brief is the stage, the same for every persona: what is happening, how the
 * conversation goes and ends. Who the AI is in it (what they want, their concerns, opening line, reactions, style) is
 * each persona's character for this role play (AgentPersona.character). Scoring is not part of the role play.
 */

const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case").max(60);
const text = (max: number) => z.string().trim().min(1).max(max);
const lines = (max: number, each = 400) => z.array(text(each)).max(max);

export const ITEM_KINDS = ["example", "objection", "question", "concern"] as const;
export const MAX_ITEMS = 200;
export const MAX_SKILL_WORDS = 2000;

export const roleplayBriefSchema = z.object({
  /** Stable id; the role play's slug is `<org>-<id>`. */
  id: kebab,
  title: text(120),
  /** One line: what this practice is. */
  summary: text(300),
  /** Shown to the learner before the call: who they are, the situation, the outcome to aim for. Never hidden facts. */
  learnerBrief: text(1000),
  ai: z.object({
    /** The AI's role in a few words, e.g. "Buyer", "Interviewer". */
    role: text(80),
  }).strict(),
  learner: z.object({
    role: text(80),
    /** What the learner is trying to achieve in the call. */
    aim: text(600),
  }).strict(),
  /** What triggered the conversation and the shared facts, the same for every persona that plays it. */
  situation: lines(15).min(1),
  start: z.object({
    /** Who speaks first; the AI's first words are in its character. */
    who: z.enum(["ai", "learner"]),
    /** What the learner does first, when they start. */
    learnerFirst: text(300).optional(),
  }).strict(),
  steps: z.array(z.object({
    id: kebab,
    name: text(80),
    /** What happens in this step and what you do. */
    what: text(800),
    moveOnWhen: text(300).optional(),
  }).strict()).min(2).max(6),
  ending: z.object({
    /** Time or count limit, e.g. "At most 4 minutes", "After 3 questions". */
    limit: text(200).optional(),
    good: text(400),
    partial: text(400).optional(),
    poor: text(400).optional(),
    /** Other moments that end it early, e.g. "two pitches with no question". */
    endsEarlyWhen: lines(5).default([]),
    exitLine: text(300).optional(),
  }).strict(),
  /** Scenario-specific rules, added to the standard ones. */
  rules: lines(10).default([]),
  items: z.array(z.object({
    kind: z.enum(ITEM_KINDS),
    text: text(1000),
    /** When this line fits. */
    context: text(300),
    step: kebab.optional(),
    tags: z.array(kebab).max(5).default([]),
  }).strict()).max(MAX_ITEMS).default([]),
  /** When to pull which kind of item (only when there are items). */
  itemsGuide: text(600).optional(),
}).strict();
export type RoleplayBrief = z.infer<typeof roleplayBriefSchema>;
export type RoleplayBriefInput = z.input<typeof roleplayBriefSchema>;

/** Fields older briefs held that now belong to each persona's character. */
export const CHARACTER_FIELDS = { top: ["wants", "concerns", "reactions", "style"], ai: ["who"], start: ["openingLine"] } as const;

/** A stored brief without the fields that moved to characters (they were ported to AgentPersona.character). */
export function stageOf(stored: unknown): unknown {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return stored;
  const brief = { ...(stored as Record<string, unknown>) };
  for (const key of CHARACTER_FIELDS.top) delete brief[key];
  for (const [part, keys] of [["ai", CHARACTER_FIELDS.ai], ["start", CHARACTER_FIELDS.start]] as const) {
    const value = brief[part];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const next = { ...(value as Record<string, unknown>) };
      for (const key of keys) delete next[key];
      brief[part] = next;
    }
  }
  return brief;
}

/**
 * A persona's character written from an older brief's character fields (who, wants, concerns, opening line,
 * reactions, style): the same port the migration roleplay_character_port does for stored role plays.
 */
export function characterFromLegacyBrief(stored: unknown): string {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
  const list = (value: unknown) => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);
  const b = record(stored);
  const start = record(b.start);
  const reactions = record(b.reactions);
  const concerns = (Array.isArray(b.concerns) ? b.concerns : []).map(record).map((c) => [
    `- ${c.hidden === true ? "(hidden until earned) " : ""}${str(c.concern)}`,
    str(c.comesUpWhen) ? `  - Comes up when: ${str(c.comesUpWhen)}` : "",
    str(c.resolvedWhen) ? `  - Eased when: ${str(c.resolvedWhen)}` : "",
  ].filter(Boolean).join("\n"));
  const opening = str(start.openingLine);
  return [
    str(record(b.ai).who) ? `## Who you are here\n\n${str(record(b.ai).who)}` : "",
    str(b.wants) || concerns.length ? `## What you want and your concerns\n\n${[str(b.wants), concerns.join("\n")].filter(Boolean).join("\n\n")}` : "",
    opening ? `## ${start.who === "learner" ? "Your first reply" : "Your opening line"}\n\n"${opening}"` : "",
    list(reactions.opensUpWhen).length || list(reactions.pullsBackWhen).length
      ? `## How you react\n\nYou open up when the learner:\n${bullets(list(reactions.opensUpWhen))}\n\nYou pull back when the learner:\n${bullets(list(reactions.pullsBackWhen))}`
      : "",
    list(b.style).length ? `## How you talk on this call\n\n${bullets(list(b.style))}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Character fields written into a brief: each must go in a persona's character instead. */
function characterFieldsIn(input: unknown): string[] {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const brief = record(input);
  return [
    ...CHARACTER_FIELDS.top.filter((key) => key in brief),
    ...CHARACTER_FIELDS.ai.filter((key) => key in record(brief.ai)).map((key) => `ai.${key}`),
    ...CHARACTER_FIELDS.start.filter((key) => key in record(brief.start)).map((key) => `start.${key}`),
  ];
}

/** Always part of a role play; scenario rules are added after these. */
export const STANDARD_RULES = [
  "Stay in your role for the whole conversation. Never mention being an AI, a simulation or a role play.",
  "Never coach, hint, evaluate or explain what the learner should do.",
  "Answer what you are asked, briefly and naturally, like a real person; share more only when it is earned.",
  "Keep every fact consistent for the whole conversation; never invent facts that contradict the situation.",
  "Vary your wording: use any example lines for substance and shape, never word for word.",
  "Never name people, places or numbers the situation doesn't give; refer to others by their role.",
  "Your name is your persona's. If the learner calls you by another name, correct them briefly (\"It's Sara, actually.\") and carry on.",
  "Never end before the limit or ending the brief sets just because the learner is doing well; go through what it asks for.",
];

/**
 * How real people talk in a live conversation, from conversation research (turn-taking and preference organization,
 * repair, response tokens; studies of LLM vs human speakers: humans are terse, disclose bit by bit, rarely praise or
 * restate, push back instead of pivoting). Rendered into every role play; the persona sets voice and personality.
 */
export const HUMAN_TALK = [
  "Most of your turns are one short sentence; many are just a few words (\"Right.\", \"Okay, and?\", \"Not really.\"). Talk at length only when you have a reason to.",
  "Answer what was asked and stop. If several questions come at once, answer the one that matters to you and let the rest go.",
  "Share one new thing at a time, and only when it has been earned; never lay out your whole situation in one go.",
  "Agree plainly and quickly. When you disagree or say no, slow down and soften it the way people do: \"Well...\", \"I mean...\", \"Hmm, I'm not sure\", agree with part of it, give a reason, or say no indirectly.",
  "Don't praise or thank the learner for questions, don't restate what they said, and don't end every turn with a question. You are not helping them; you are a person in this situation.",
  "When the learner is explaining, a short reaction is often enough (\"Mm.\", \"Right.\", \"Okay.\") so they keep going.",
  "If you didn't follow, say so (\"Sorry, meaning what?\", \"Which one?\") instead of guessing.",
  "Hold your position: if they haven't dealt with your point, say it again, more bluntly, rather than moving on. Your mood carries over from turn to turn and changes gradually.",
  "Remember what was said earlier and notice when it doesn't add up.",
  "Speak like talking, not writing: contractions, everyday words, no lists, dashes or stage directions.",
];

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** SKILL.md: the stage every persona plays, written to "you". Never the learner's scoring, never one persona. */
export function renderBriefSkill(brief: RoleplayBrief): string {
  const b = brief;
  const start = b.start.who === "ai"
    ? "You speak first, with your character's opening line."
    : [
      `The learner starts the conversation${b.start.learnerFirst ? `: ${b.start.learnerFirst}` : "."}`,
      "On the opening turn, before the learner has said anything, say only a short, neutral line that fits the situation and wait: after a meeting or presentation \"Okay, thanks.\", on a phone call \"Hello?\". Raise nothing yet.",
      "Once the learner has started, reply as your character's first reply says.",
    ].join("\n");
  const ending = [
    b.ending.limit ? `- ${b.ending.limit}` : "",
    `- Good outcome: ${b.ending.good}`,
    b.ending.partial ? `- Partial: ${b.ending.partial}` : "",
    b.ending.poor ? `- Poor: ${b.ending.poor}` : "",
    ...b.ending.endsEarlyWhen.map((when) => `- End early when: ${when}`),
    b.ending.exitLine ? `- If you end it early or without a next step, say only: "${b.ending.exitLine}" A good ending closes naturally instead.` : "",
  ].filter(Boolean).join("\n");
  const sections = [
    `---\nname: ${b.id}\ndescription: ${JSON.stringify(b.summary)}\n---`,
    `# ${b.title}\n\n${b.summary}`,
    `## Your role\n\nYou play the ${b.ai.role}: the persona described in PERSONA, as your CHARACTER for this role play describes you (what you want, your concerns and what you keep hidden, how you react and talk).`,
    `## The learner\n\nThe learner plays: ${b.learner.role}. ${b.learner.aim}`,
    `## Situation\n\n${bullets(b.situation)}`,
    `## How it starts\n\n${start}`,
    `## How the conversation goes\n\n${b.steps.map((s, i) => `### ${i + 1}. ${s.name} \`${s.id}\`\n\n**Goal:** ${s.what}${s.moveOnWhen ? `\n\nMove on when: ${s.moveOnWhen}` : ""}`).join("\n\n")}`,
    `## How you react\n\nAs your character says. Stay reasonable and firm, not hostile; move gradually, never all at once. Reveal what your character keeps hidden only when the learner asks a genuine question about it and listens; one piece at a time.`,
    `## How it ends\n\n${ending}`,
    `## Rules\n\n${bullets([...STANDARD_RULES, ...b.rules])}`,
    `## How real people talk\n\n${bullets(HUMAN_TALK)}`,
    b.items.length ? `## Using your lines\n\n${b.itemsGuide ?? "When you reach a step or a new kind of moment, look up your lines for it; use them for substance and shape and vary the wording."}` : "",
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/** Problems a trainer must fix before publishing; empty when the brief is complete and consistent. */
export function checkBrief(brief: RoleplayBrief): string[] {
  const b = brief;
  const reasons: string[] = [];
  if (norm(b.ai.role) === norm(b.learner.role)) reasons.push("The AI and the learner play the same role; give each a distinct role.");
  if (b.start.who === "learner" && !b.start.learnerFirst) reasons.push("The learner speaks first: say what they do first (start.learnerFirst).");
  const ids = b.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) reasons.push("Step ids must be unique.");
  if (!b.ending.limit && !b.ending.endsEarlyWhen.length && !/\b(after|when|once|until|minute|question|objection)\b/i.test(b.ending.good)) {
    reasons.push("Say when the conversation ends: a time or count limit, or what ends it.");
  }
  for (const item of b.items) if (item.step && !ids.includes(item.step)) reasons.push(`Item "${item.text.slice(0, 40)}" names step "${item.step}", which does not exist.`);
  const seen = new Set<string>();
  for (const item of b.items) {
    const key = norm(item.text);
    if (seen.has(key)) reasons.push(`Item listed twice: "${item.text.slice(0, 60)}".`);
    seen.add(key);
  }
  if (b.items.length && !b.itemsGuide) reasons.push("There are items: add itemsGuide (when to pull which kind).");
  const all = JSON.stringify(b);
  const pii = all.match(/[\w.+-]+@[\w-]+\.[\w.-]+|\bhttps?:\/\/\S+|\bwww\.\S+|\+?\d(?:[ .-]?\d){9,}/i);
  if (pii) reasons.push(`Remove personal or contact details: "${pii[0].slice(0, 40)}".`);
  const n = words(renderBriefSkill(b));
  if (n > MAX_SKILL_WORDS) reasons.push(`SKILL.md has ${n} words; keep it under ${MAX_SKILL_WORDS} (move long lists into items).`);
  return [...new Set(reasons)];
}

/** The package files from a brief: SKILL.md, scenario.json (manifest) and items.json. */
export function renderBrief(brief: RoleplayBrief) {
  const skill = renderBriefSkill(brief);
  const scenario = {
    scenario: brief.id,
    name: brief.title,
    description: brief.learnerBrief,
    trainer_role: brief.ai.role,
    learner_role: brief.learner.role,
    steps: brief.steps.map((s) => ({ id: s.id, name: s.name, trainer_moves: [] as string[], learner_moves: [] as string[] })),
    source: "brief",
  };
  const items = brief.items.map((item, index) => ({
    id: `${brief.id}-${item.kind}-${index + 1}`,
    role: "trainer" as const,
    context: `${item.kind}${item.tags.length ? ` (${item.tags.join(", ")})` : ""}: ${item.context}`,
    text: item.text,
    metadata: { ...(item.step ? { step: item.step } : {}), kind: item.kind, source: "authored", ...(item.tags.length ? { tags: item.tags } : {}) },
  }));
  return { skill, scenario, items };
}

/** Parses, checks and renders: what the copilot's draft shows and what publishing stores. */
export function draftBrief(input: unknown) {
  const moved = characterFieldsIn(input);
  if (moved.length) {
    return { ok: false as const, reasons: [`${moved.join(", ")}: these belong to each persona's character, not the brief (the stage). Remove them here and write them per persona with roleplay_character_set.`] };
  }
  const parsed = roleplayBriefSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, reasons: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "brief"}: ${issue.message}`) };
  }
  const reasons = checkBrief(parsed.data);
  return { ok: reasons.length === 0, reasons, brief: parsed.data, ...renderBrief(parsed.data) };
}
