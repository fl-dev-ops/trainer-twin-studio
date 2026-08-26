import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
const nonEmpty = z.string().trim().min(1);
const claimHandling = z.enum([
  "resume_evidence",
  "conceptual",
  "hypothetical_design",
  "coding_execution",
  "session_feedback",
]);
const action = z.enum([
  "ask_exact_example",
  "ask_reflection",
  "ask_reflective_walkthrough",
  "close_session",
  "deepen_with_edge_case",
  "deepen_with_tradeoff",
  "isolate_missing_part",
  "narrow_hint",
  "present_coding_problem",
  "present_feedback",
  "probe_required_evidence",
  "redirect_role",
  "request_code",
  "request_justification",
  "request_revision",
  "reveal_requirement",
  "run_code",
  "scaffold_missing_link",
  "surface_contradiction",
  "transition_phase",
]);
const contextMode = z.enum([
  "none",
  "resume_grounding",
  "resume_topics_only",
  "scenario_only",
  "session_evidence",
]);
const knowledgeSelection = z.enum(["adaptive_seniority", "resume_topic_intersection"]);
const tool = z.union([
  z.literal("coding_sandbox"),
  z.object({
    id: z.literal("coding_sandbox"),
    network: z.literal("disabled"),
    timeout_seconds: z.number().int().min(1).max(60),
    memory_mb: z.number().int().min(64).max(1024),
    language: nonEmpty,
  }).strict(),
]);

const actionsSchema = z.object({
  allowed: z.array(action).min(1),
  default: action,
  max_probes_per_lane: z.number().int().min(1).max(10).optional(),
}).strict().superRefine((actions, ctx) => {
  if (!actions.allowed.includes(actions.default)) {
    ctx.addIssue({ code: "custom", message: "Default action must be allowed", path: ["default"] });
  }
});

const stageActionsSchema = z.object({
  allowed: z.array(action).min(1),
  default: action.optional(),
  max_probes_per_lane: z.number().int().min(1).max(10).optional(),
}).strict().superRefine((actions, ctx) => {
  if (actions.default && !actions.allowed.includes(actions.default)) {
    ctx.addIssue({ code: "custom", message: "Default action must be allowed", path: ["default"] });
  }
});

const evidenceSchema = z.object({
  definitions: z.record(slug, nonEmpty),
  keys: z.array(slug).min(1),
  completion_keys: z.array(slug).min(1),
}).strict().superRefine((evidence, ctx) => {
  const defined = new Set(Object.keys(evidence.definitions));
  for (const [field, keys] of [["keys", evidence.keys], ["completion_keys", evidence.completion_keys]] as const) {
    keys.forEach((key, index) => {
      if (!defined.has(key)) ctx.addIssue({ code: "custom", message: `Unknown evidence key: ${key}`, path: [field, index] });
    });
  }
});

const stageSchema = z.object({
  id: slug,
  name: nonEmpty,
  objective: nonEmpty,
  opening: nonEmpty,
  config: z.object({
    knowledge: z.object({
      tags: z.array(slug),
      selection: knowledgeSelection.optional(),
      retrieval: z.enum(["enabled", "disabled"]).optional(),
      maximum_topics: z.number().int().min(1).max(10).optional(),
    }).strict(),
    claim_handling: claimHandling,
    context: z.object({ mode: contextMode, required: z.boolean().optional() }).strict(),
    evidence: evidenceSchema,
    turns: z.object({ minimum: z.number().int().min(0), maximum: z.number().int().min(1) }).strict(),
    actions: stageActionsSchema.optional(),
    tools: z.array(tool).optional(),
    scenario: z.record(z.string(), z.unknown()).optional(),
  }).strict().superRefine((config, ctx) => {
    if (config.turns.minimum > config.turns.maximum) {
      ctx.addIssue({ code: "custom", message: "Minimum turns cannot exceed maximum", path: ["turns"] });
    }
  }),
}).strict();

export const agentSpecSchema = z.object({
  id: slug,
  name: nonEmpty,
  version: z.number().int().positive(),
  domain: slug,
  objective: nonEmpty,
  opening: nonEmpty,
  config: z.object({
    claim_handling: claimHandling,
    context: z.object({
      mode: contextMode,
      required: z.boolean(),
      available_sources: z.array(nonEmpty).optional(),
    }).strict(),
    scenario: z.record(z.string(), z.unknown()),
    tools: z.array(tool),
    actions: actionsSchema,
    evidence: z.object({ statuses: z.array(z.enum(["untested", "partial", "sufficient", "weak", "unresolved"])).min(1) }).strict(),
    turns: z.object({ maximum: z.number().int().min(1) }).strict(),
    rendering: z.object({
      maximum_words: z.number().int().min(10).max(200),
      maximum_question_marks: z.number().int().min(0).max(3),
      one_focal_ask: z.boolean(),
      deterministic_closing: z.boolean(),
    }).strict(),
  }).strict(),
  stages: z.array(stageSchema).min(1),
}).strict().superRefine((agent, ctx) => {
  const ids = new Set<string>();
  agent.stages.forEach((stage, index) => {
    if (ids.has(stage.id)) ctx.addIssue({ code: "custom", message: `Duplicate stage: ${stage.id}`, path: ["stages", index, "id"] });
    ids.add(stage.id);
  });
});

export const domainSpecSchema = z.object({
  id: slug,
  name: nonEmpty,
  version: z.number().int().positive(),
  knowledge_bases: z.array(slug).min(1),
  principles: z.array(nonEmpty).min(1),
  classifications: z.record(slug, nonEmpty),
}).strict();

export const groundingSchema = z.object({
  knowledgeBase: slug,
  source: nonEmpty,
  documentId: nonEmpty.optional(),
  stageIds: z.array(slug).min(1),
  purpose: nonEmpty,
  queryGuidance: nonEmpty,
  tags: z.array(slug),
}).strict();

export const specDraftBundleSchema = z.object({
  slug,
  name: nonEmpty,
  personaSlug: slug.optional(),
  agent: agentSpecSchema,
  domain: domainSpecSchema,
  grounding: z.array(groundingSchema).min(1),
  assumptions: z.array(nonEmpty).default([]),
  gaps: z.array(nonEmpty).default([]),
}).strict().superRefine((bundle, ctx) => {
  if (bundle.agent.id !== bundle.slug) ctx.addIssue({ code: "custom", message: "Agent id must match draft slug", path: ["agent", "id"] });
  if (bundle.agent.domain !== bundle.domain.id) ctx.addIssue({ code: "custom", message: "Agent domain must match Domain id", path: ["agent", "domain"] });
  const stageIds = new Set(bundle.agent.stages.map((stage) => stage.id));
  const knowledgeBases = new Set(bundle.domain.knowledge_bases);
  bundle.grounding.forEach((reference, index) => {
    if (!knowledgeBases.has(reference.knowledgeBase)) ctx.addIssue({ code: "custom", message: "Grounding references an unselected knowledge base", path: ["grounding", index, "knowledgeBase"] });
    reference.stageIds.forEach((stageId, stageIndex) => {
      if (!stageIds.has(stageId)) ctx.addIssue({ code: "custom", message: `Unknown grounded stage: ${stageId}`, path: ["grounding", index, "stageIds", stageIndex] });
    });
  });
});

export type SpecDraftBundle = z.infer<typeof specDraftBundleSchema>;
