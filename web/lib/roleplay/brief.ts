import { z } from "zod";

/**
 * A role play written from a trainer's requirements (plans/roleplay-creator.md): one structured brief, rendered into
 * the role play's SKILL.md (the AI's brief, written to "you"), the learner brief and items (lines the AI may pull).
 * Deterministic and client-safe. The persona (Persona Library) gives the voice and personality; the brief says what is
 * happening now and what this person wants and does in it. Scoring is not part of the role play.
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
    /** Who you are in this situation and your relationship to the learner. Personality comes from the persona. */
    who: text(1200),
  }).strict(),
  learner: z.object({
    role: text(80),
    /** What the learner is trying to achieve in the call. */
    aim: text(600),
  }).strict(),
  /** What triggered the conversation, what you know and don't know, how you feel at the start, facts to keep. */
  situation: lines(15).min(1),
  /** Your aim in the conversation. */
  wants: text(800),
  concerns: z.array(z.object({
    /** The concern, as this person would put it. Never the answer to it. */
    concern: text(400),
    comesUpWhen: text(300).optional(),
    resolvedWhen: text(300).optional(),
    /** Kept to yourself until the learner earns it. */
    hidden: z.boolean().default(false),
  }).strict()).max(5).default([]),
  start: z.object({
    who: z.enum(["ai", "learner"]),
    /** Your first words (when you start), or your first reply (when the learner starts). */
    openingLine: text(400).optional(),
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
  reactions: z.object({
    opensUpWhen: lines(10).min(1),
    pullsBackWhen: lines(10).min(1),
  }).strict(),
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
  /** Scenario-specific speaking constraints only (length, pace); tone and personality come from the persona. */
  style: lines(5).default([]),
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

/** Always part of a role play; scenario rules are added after these. */
export const STANDARD_RULES = [
  "Stay in your role for the whole conversation. Never mention being an AI, a simulation or a role play.",
  "Never coach, hint, evaluate or explain what the learner should do.",
  "Answer what you are asked, briefly and naturally, like a real person; share more only when it is earned.",
  "Keep every fact consistent for the whole conversation; never invent facts that contradict the situation.",
  "Vary your wording: use any example lines for substance and shape, never word for word.",
  "Never name people, places or numbers the situation doesn't give; refer to others by their role.",
  "Never end before the limit or ending the brief sets just because the learner is doing well; go through what it asks for.",
];

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** SKILL.md: the AI's brief. Never the learner's scoring. */
export function renderBriefSkill(brief: RoleplayBrief): string {
  const b = brief;
  const start = b.start.who === "ai"
    ? `You speak first${b.start.openingLine ? `: "${b.start.openingLine}"` : "."}`
    : [`The learner speaks first${b.start.learnerFirst ? `: ${b.start.learnerFirst}` : "."}`, b.start.openingLine ? `Your first reply: "${b.start.openingLine}"` : ""].filter(Boolean).join("\n");
  const concerns = b.concerns.map((c) => [
    `- ${c.hidden ? "(hidden until earned) " : ""}${c.concern}`,
    c.comesUpWhen ? `  - Comes up when: ${c.comesUpWhen}` : "",
    c.resolvedWhen ? `  - Eased when: ${c.resolvedWhen}` : "",
  ].filter(Boolean).join("\n"));
  const ending = [
    b.ending.limit ? `- ${b.ending.limit}` : "",
    `- Good outcome: ${b.ending.good}`,
    b.ending.partial ? `- Partial: ${b.ending.partial}` : "",
    b.ending.poor ? `- Poor: ${b.ending.poor}` : "",
    ...b.ending.endsEarlyWhen.map((when) => `- End early when: ${when}`),
    b.ending.exitLine ? `- If you end it early or without a next step, say only: "${b.ending.exitLine}" A good ending closes naturally instead.` : "",
  ].filter(Boolean).join("\n");
  const hasHidden = b.concerns.some((c) => c.hidden);
  const sections = [
    `---\nname: ${b.id}\ndescription: ${JSON.stringify(b.summary)}\n---`,
    `# ${b.title}\n\n${b.summary}`,
    `## Your role\n\n${b.ai.who}`,
    `## The learner\n\nThe learner plays: ${b.learner.role}. ${b.learner.aim}`,
    `## Situation\n\n${bullets(b.situation)}`,
    `## What you want and your concerns\n\n${b.wants}${concerns.length ? `\n\n${concerns.join("\n")}` : ""}${hasHidden ? "\n\nReveal a hidden concern only when the learner asks a genuine question about it and listens; one piece at a time." : ""}`,
    `## How it starts\n\n${start}`,
    `## How the conversation goes\n\n${b.steps.map((s, i) => `### ${i + 1}. ${s.name} \`${s.id}\`\n\n**Goal:** ${s.what}${s.moveOnWhen ? `\n\nMove on when: ${s.moveOnWhen}` : ""}`).join("\n\n")}`,
    `## How you react\n\nYou open up when the learner:\n${bullets(b.reactions.opensUpWhen)}\n\nYou pull back when the learner:\n${bullets(b.reactions.pullsBackWhen)}\n\nStay reasonable and firm, not hostile; move gradually, never all at once.`,
    `## How it ends\n\n${ending}`,
    `## Rules\n\n${bullets([...STANDARD_RULES, ...b.rules])}`,
    b.style.length ? `## Style\n\n${bullets(b.style)}` : "",
    b.items.length ? `## Using your lines\n\n${b.itemsGuide ?? "When you reach a step or a new kind of moment, look up your lines for it; use them for substance and shape and vary the wording."}` : "",
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/** Problems a trainer must fix before publishing; empty when the brief is complete and consistent. */
export function checkBrief(brief: RoleplayBrief): string[] {
  const b = brief;
  const reasons: string[] = [];
  if (norm(b.ai.role) === norm(b.learner.role)) reasons.push("The AI and the learner play the same role; give each a distinct role.");
  if (b.start.who === "ai" && !b.start.openingLine) reasons.push("The AI speaks first: add its opening line.");
  if (b.start.who === "learner" && !b.start.learnerFirst) reasons.push("The learner speaks first: say what they do first (start.learnerFirst).");
  const ids = b.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) reasons.push("Step ids must be unique.");
  if (!b.ending.limit && !b.ending.endsEarlyWhen.length && !/\b(after|when|once|until|minute|question|objection)\b/i.test(b.ending.good)) {
    reasons.push("Say when the conversation ends: a time or count limit, or what ends it.");
  }
  const brief_ = norm(b.learnerBrief);
  for (const c of b.concerns.filter((x) => x.hidden)) {
    const n = norm(c.concern);
    if (n.length >= 12 && brief_.includes(n)) reasons.push(`The learner brief gives away a hidden concern: "${c.concern.slice(0, 80)}".`);
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
  const parsed = roleplayBriefSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, reasons: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "brief"}: ${issue.message}`) };
  }
  const reasons = checkBrief(parsed.data);
  return { ok: reasons.length === 0, reasons, brief: parsed.data, ...renderBrief(parsed.data) };
}
