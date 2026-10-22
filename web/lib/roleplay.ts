import { z } from "zod";
import type { SpecDraftBundle } from "@/lib/spec-draft-schema";

/**
 * Client role-play scenarios. A scenario is a role-play exactly when its agent
 * spec carries `config.scenario.roleplay`; everything else is a Twin (interview)
 * scenario. Role-play specs are built deterministically from the builder fields
 * (no LLM), then saved through the normal draft/publish flow.
 */

export const DIFFICULTIES = [
  { value: "easy", label: "Easy", description: "Nervous but willing. Opens up quickly once the agent asks a good question." },
  { value: "medium", label: "Medium", description: "Guarded at first. Opens up only when the agent earns it." },
  { value: "hard", label: "Hard", description: "Confident and testing. Impatient with weak or scripted questions." },
  { value: "hardest", label: "Hardest", description: "Hides the real issue. Ends the call quickly after mistakes." },
] as const;

export type Difficulty = (typeof DIFFICULTIES)[number]["value"];

export const CHARACTER_ROLES = [
  "Warm & Open",
  "Warm but Cautious",
  "Curious & Probing",
  "Skeptical & Reserved",
  "Direct & Challenging",
] as const;

export const MAX_LEARNER_GOALS = 5;
const MAX_REACTIONS = 12;

const line = z.string().trim().min(1).max(300);
const paragraph = (label: string) => z.string().trim().min(1, `${label} is required`).max(4000);

export const roleplayInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  persona: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "Choose who the learner will speak with"),
  clientName: z.string().trim().max(120).optional(),
  voiceId: z.string().optional(),
  situation: z.object({
    scenario: paragraph("Scenario"),
    hiddenTruth: z.string().trim().max(4000).optional(),
    learnerRole: z.string().trim().min(1, "Learner role is required").max(200),
    agreesWhen: z.string().trim().max(2000).optional(),
    declinesWhen: z.string().trim().max(2000).optional(),
  }),
  learnerGoals: z.array(line).min(1, "Add at least one learner goal").max(MAX_LEARNER_GOALS, `Five learner goals at most`),
  agent: z.object({
    characterRole: z.enum(CHARACTER_ROLES),
    difficulty: z.enum(["easy", "medium", "hard", "hardest"]),
    howTheyTalk: z.string().trim().max(2000).optional(),
    guardedIf: z.array(line).max(MAX_REACTIONS).default([]),
    opensUpIf: z.array(line).max(MAX_REACTIONS).default([]),
    whatToExpect: z.string().trim().max(2000).optional(),
  }),
  opening: z.string().trim().min(1, "Opening message is required").max(1000),
});

export type RoleplayInput = z.infer<typeof roleplayInputSchema>;

/** Shape stored at `agent.config.scenario.roleplay`. */
export type StoredRoleplay = {
  version: 1;
  persona: string;
  client_name?: string;
  situation: {
    scenario: string;
    hidden_truth?: string;
    learner_role: string;
    agrees_when?: string;
    declines_when?: string;
  };
  agent: {
    character_role: string;
    difficulty: Difficulty;
    how_they_talk?: string;
    reactions: { guarded_if: string[]; opens_up_if: string[] };
    what_to_expect?: string;
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The stored role-play block of an agent spec, or null for Twin scenarios. */
export function getStoredRoleplay(agentData: unknown): StoredRoleplay | null {
  const roleplay = asRecord(asRecord(asRecord(asRecord(agentData)?.config)?.scenario)?.roleplay);
  return roleplay ? roleplay as unknown as StoredRoleplay : null;
}

export function isRoleplayAgentData(agentData: unknown): boolean {
  return getStoredRoleplay(agentData) !== null;
}

const optional = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);

function storedRoleplay(input: RoleplayInput): StoredRoleplay {
  return {
    version: 1,
    persona: input.persona,
    ...(optional(input.clientName) ? { client_name: optional(input.clientName) } : {}),
    situation: {
      scenario: input.situation.scenario,
      ...(optional(input.situation.hiddenTruth) ? { hidden_truth: optional(input.situation.hiddenTruth) } : {}),
      learner_role: input.situation.learnerRole,
      ...(optional(input.situation.agreesWhen) ? { agrees_when: optional(input.situation.agreesWhen) } : {}),
      ...(optional(input.situation.declinesWhen) ? { declines_when: optional(input.situation.declinesWhen) } : {}),
    },
    agent: {
      character_role: input.agent.characterRole,
      difficulty: input.agent.difficulty,
      ...(optional(input.agent.howTheyTalk) ? { how_they_talk: optional(input.agent.howTheyTalk) } : {}),
      reactions: { guarded_if: input.agent.guardedIf, opens_up_if: input.agent.opensUpIf },
      ...(optional(input.agent.whatToExpect) ? { what_to_expect: optional(input.agent.whatToExpect) } : {}),
    },
  };
}

/**
 * Builds a complete, schema-valid spec bundle for a role-play scenario. The
 * interview-only fields keep the minimal values the compiler requires; the brain
 * ignores them for role-play sessions.
 */
export function buildRoleplayBundle(input: RoleplayInput, options: {
  slug: string;
  agentVersion?: number;
  domainId?: string;
  domainVersion?: number;
}): SpecDraftBundle {
  const domainId = options.domainId ?? `domain-${options.slug}`;
  const goals = input.learnerGoals.map((goal, index) => [`goal_${index + 1}`, goal] as const);
  const goalKeys = goals.map(([key]) => key);
  const learnerRole = input.situation.learnerRole;

  return {
    slug: options.slug,
    name: input.name,
    personaSlug: input.persona,
    agent: {
      id: options.slug,
      name: input.name,
      version: options.agentVersion ?? 1,
      domain: domainId,
      objective: `${learnerRole}: ${input.learnerGoals.join("; ")}`,
      opening: input.opening,
      config: {
        interview: { schema_version: 1, type: "resume", follow_ups_per_main_question: 0, main_questions: 1 },
        claim_handling: "session_feedback",
        context: { mode: "none", required: false },
        scenario: { roleplay: storedRoleplay(input) },
        tools: [],
        actions: { allowed: ["probe_required_evidence", "close_session"], default: "probe_required_evidence" },
        evidence: { statuses: ["untested", "partial", "sufficient", "weak", "unresolved"] },
        turns: { maximum: 60 },
        rendering: { maximum_words: 80, maximum_question_marks: 2, one_focal_ask: false, deterministic_closing: false },
      },
      ...(input.voiceId ? { voiceId: input.voiceId } : {}),
      stages: [{
        id: "call",
        name: "Client call",
        objective: `Learner goals for ${learnerRole}.`,
        opening: input.opening,
        config: {
          knowledge: { tags: [], retrieval: "disabled" },
          claim_handling: "session_feedback",
          context: { mode: "none" },
          evidence: {
            definitions: Object.fromEntries(goals),
            keys: goalKeys,
            completion_keys: goalKeys,
          },
          turns: { minimum: 1, maximum: 60 },
        },
      }],
    },
    domain: {
      id: domainId,
      name: `${input.name} (role play)`,
      version: options.domainVersion ?? 1,
      knowledge_bases: [],
      principles: ["Score only the learner. The AI plays the client and is never evaluated."],
      classifications: { met: "The learner clearly did this.", partly: "The learner attempted this but not fully.", not_met: "The learner did not do this." },
    },
    grounding: [],
    assumptions: [],
    gaps: [],
  };
}

/** Builder field values for an existing role-play spec (for the editor). */
export function roleplayInputFromSpec(agentData: Record<string, unknown>): Partial<RoleplayInput> | null {
  const stored = getStoredRoleplay(agentData);
  if (!stored) return null;
  const stage = Array.isArray(agentData.stages) ? asRecord(agentData.stages[0]) : null;
  const evidence = asRecord(asRecord(stage?.config)?.evidence);
  const definitions = asRecord(evidence?.definitions) ?? {};
  const keys = Array.isArray(evidence?.keys) ? evidence.keys as string[] : Object.keys(definitions);
  return {
    name: typeof agentData.name === "string" ? agentData.name : "",
    persona: stored.persona,
    clientName: stored.client_name,
    voiceId: typeof agentData.voiceId === "string" ? agentData.voiceId : undefined,
    situation: {
      scenario: stored.situation?.scenario ?? "",
      hiddenTruth: stored.situation?.hidden_truth,
      learnerRole: stored.situation?.learner_role ?? "",
      agreesWhen: stored.situation?.agrees_when,
      declinesWhen: stored.situation?.declines_when,
    },
    learnerGoals: keys.map((key) => definitions[key]).filter((goal): goal is string => typeof goal === "string"),
    agent: {
      characterRole: (CHARACTER_ROLES as readonly string[]).includes(stored.agent?.character_role)
        ? stored.agent.character_role as RoleplayInput["agent"]["characterRole"]
        : "Warm but Cautious",
      difficulty: stored.agent?.difficulty ?? "medium",
      howTheyTalk: stored.agent?.how_they_talk,
      guardedIf: stored.agent?.reactions?.guarded_if ?? [],
      opensUpIf: stored.agent?.reactions?.opens_up_if ?? [],
      whatToExpect: stored.agent?.what_to_expect,
    },
    opening: typeof agentData.opening === "string" ? agentData.opening : "",
  };
}

/** Client personas shown as avatar cards in the role-play builder. */
export type ClientPersonaCard = {
  slug: string;
  name: string;
  role: string;
  avatar?: string;
  voiceId?: string;
  background?: string;
  behaviours: string[];
  howTheyTalk?: string;
};

export function isClientPersonaData(data: unknown): boolean {
  return asRecord(data)?.kind === "client";
}

export function clientPersonaCard(slug: string, data: unknown): ClientPersonaCard | null {
  const record = asRecord(data);
  if (!record || record.kind !== "client") return null;
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  return {
    slug,
    name: str(record.name) ?? slug,
    role: str(record.role) ?? "Client",
    avatar: str(record.avatar),
    voiceId: str(record.voiceId),
    background: str(record.background),
    behaviours: Array.isArray(record.behaviours) ? record.behaviours.filter((b): b is string => typeof b === "string") : [],
    howTheyTalk: str(record.how_they_talk),
  };
}
