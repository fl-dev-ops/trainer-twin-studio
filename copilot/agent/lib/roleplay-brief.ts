import { z } from "zod";

// The role-play brief the copilot writes from a trainer's requirements. Same shape as web/lib/roleplay/brief.ts (the
// studio renders and checks it; a web contract test keeps the two in step). The descriptions are the writing guidance
// the model sees: write to the AI as "you", situation not personality, concerns without answers.

const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case").max(60);
const text = (max: number) => z.string().trim().min(1).max(max);
const lines = (max: number, each = 400) => z.array(text(each)).max(max);

export const roleplayBrief = z.object({
  id: kebab.describe("Stable id for this role play, kebab-case, e.g. \"first-call-after-ad\". Keep it when editing."),
  title: text(120).describe("Short title the trainer recognises."),
  summary: text(300).describe("One line: what this practice is, e.g. \"An agent calls back a property enquiry; you are the buyer.\""),
  learnerBrief: text(1000).describe("Shown to the learner before the call, written to them: who they are, the situation, the outcome to aim for, the time limit. Never the AI's hidden concerns or how it will react."),
  ai: z.object({
    role: text(80).describe("The AI's role in a few words: Buyer, Interviewer, Employee, Co-founder, Audience member."),
    who: text(1200).describe("Written to the AI as \"You are…\": who you are IN THIS SITUATION and your relationship to the learner. Do not describe personality or speaking style; the persona carries those."),
  }).strict(),
  learner: z.object({
    role: text(80).describe("Who the learner plays, e.g. Real estate agent, Candidate, Founder."),
    aim: text(600).describe("What the learner is trying to achieve in the call, written about them (\"They want to…\")."),
  }).strict(),
  situation: lines(15).min(1).describe("Bullets written to the AI: what triggered this conversation, what you know and don't know, how you feel at the start, facts to keep consistent (budget, product, numbers)."),
  wants: text(800).describe("Your aim in this conversation, written to the AI."),
  concerns: z.array(z.object({
    concern: text(400).describe("The concern as this person sees or says it. Never write the answer to it."),
    comesUpWhen: text(300).optional().describe("When it comes up."),
    resolvedWhen: text(300).optional().describe("What the learner must do for it to ease."),
    hidden: z.boolean().default(false).describe("True when you keep it to yourself until the learner earns it with a genuine question."),
  }).strict()).max(5).default([]).describe("1 to 5 concerns for a counterpart (buyer, employee, stakeholder); often none for an interviewer."),
  start: z.object({
    who: z.enum(["ai", "learner"]).describe("Who speaks first."),
    openingLine: text(400).optional().describe("Your first words (when you start) or your first reply (when the learner starts). Required when the AI starts."),
    learnerFirst: text(300).optional().describe("What the learner does first, when they start, e.g. \"The agent asks: 'Is this something you could consider?'\""),
  }).strict(),
  steps: z.array(z.object({
    id: kebab.describe("kebab-case step id."),
    name: text(80),
    what: text(800).describe("What happens in this step and what you do, written to the AI. Include moments you bring in on purpose (\"Around the middle, say: …\")."),
    moveOnWhen: text(300).optional().describe("When to move to the next step."),
  }).strict()).min(2).max(6).describe("2 to 6 steps in order. A real conversation, not a checklist of questions."),
  reactions: z.object({
    opensUpWhen: lines(10).min(1).describe("Observable things the learner does that make you open up, e.g. \"asks about your family's needs\"."),
    pullsBackWhen: lines(10).min(1).describe("Observable things that make you pull back, e.g. \"pitches before asking anything\". Resistance is reasonable and firm, not hostile."),
  }).strict(),
  ending: z.object({
    limit: text(200).optional().describe("Time or count limit, e.g. \"At most 4 minutes.\", \"After 3 questions.\""),
    good: text(400).describe("What a good ending looks like."),
    partial: text(400).optional(),
    poor: text(400).optional(),
    endsEarlyWhen: lines(5).default([]).describe("Moments that end it early, e.g. \"two pitches without a question\"."),
    exitLine: text(300).optional().describe("What you say when you end it."),
  }).strict(),
  rules: lines(10).default([]).describe("Scenario-specific always/never rules only. Standard rules (stay in role, never coach, keep facts consistent, vary wording) are added automatically."),
  style: lines(5).default([]).describe("Scenario-specific speaking constraints only, e.g. \"At most 45 words per turn.\" Tone and personality come from the persona."),
  items: z.array(z.object({
    kind: z.enum(["example", "objection", "question", "concern"]),
    text: text(1000).describe("The line as the trainer wrote it. Never invent lines."),
    context: text(300).describe("When this line fits."),
    step: kebab.optional().describe("The step it belongs to, if any."),
    tags: z.array(kebab).max(5).default([]).describe("Short tags, e.g. investor, end-user, technical."),
  }).strict()).max(200).default([]).describe("Lines from the trainer's requirements the AI can look up during the call (objection lists, question banks, sample lines). Only lines the trainer gave."),
  itemsGuide: text(600).optional().describe("Required with items: when to look up which kind, written to the AI."),
}).strict();
export type RoleplayBrief = z.infer<typeof roleplayBrief>;
