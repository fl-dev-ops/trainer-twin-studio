import { z } from "zod";

// Mirrors web/lib/roleplay.ts roleplayInputSchema; the Studio validates again on save.
const line = z.string().trim().min(1).max(300);

export const CHARACTER_ROLES = [
  "Warm & Open",
  "Warm but Cautious",
  "Curious & Probing",
  "Skeptical & Reserved",
  "Direct & Challenging",
] as const;

export const roleplayInputSchema = z.object({
  name: z.string().trim().min(1).max(120).describe("Short role-play name shown to trainers and learners."),
  persona: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).describe("Slug of a client persona from studio_inventory (client: true)."),
  clientName: z.string().trim().max(120).optional().describe("Name the client uses on the call; defaults to the persona's name."),
  situation: z.object({
    scenario: z.string().trim().min(1).max(4000).describe("Who the client is, what happened before the call, what they say on the surface."),
    hiddenTruth: z.string().trim().max(4000).optional().describe("The real fear or motive, revealed only when the learner earns it."),
    learnerRole: z.string().trim().min(1).max(200),
    agreesWhen: z.string().trim().max(2000).optional(),
    declinesWhen: z.string().trim().max(2000).optional(),
  }),
  learnerGoals: z.array(line).min(1).max(5).describe("What the learner is scored on; one observable behaviour each."),
  agent: z.object({
    characterRole: z.enum(CHARACTER_ROLES),
    difficulty: z.enum(["easy", "medium", "hard", "hardest"]),
    howTheyTalk: z.string().trim().max(2000).optional(),
    guardedIf: z.array(line).max(12).default([]),
    opensUpIf: z.array(line).max(12).default([]),
  }),
  opening: z.string().trim().min(1).max(1000).describe("The first line the client says."),
  rubric: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    points: z.number().int().min(1).max(100),
  })).min(1).max(8)
    .describe("Scoring criteria with points per row; usually adding up to 100."),
});
