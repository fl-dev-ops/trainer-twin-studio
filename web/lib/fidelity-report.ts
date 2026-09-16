import { z } from "zod";

const score = z.number().min(0).max(1).nullable();

const knowledgeResultSchema = z.object({
  chunkId: z.string(),
  docId: z.string(),
  kbId: z.string().optional(),
  source: z.string(),
  title: z.string().optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  topic: z.string().optional(),
  text: z.string(),
  score: z.number(),
}).passthrough();

const runSchema = z.object({
  runId: z.string(),
  learner: z.object({ name: z.string(), source: z.string().nullable().optional() }),
  personaFidelity: z.object({ score, reason: z.string().nullable().optional() }),
  sessionQuality: z.object({
    score,
    completeness: score,
    roleAdherence: score,
  }),
  knowledgeSearches: z.array(z.object({
    name: z.string(),
    callId: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()),
  knowledgeRetrievals: z.array(z.object({
    callId: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.object({
      results: z.array(knowledgeResultSchema),
    }).passthrough(),
  }).passthrough()).default([]),
  knowledgeTrackingAvailable: z.boolean(),
  decisionRecords: z.array(z.object({
    turnIndex: z.number().int().nonnegative(),
    learnerState: z.string(),
    move: z.string(),
    reason: z.string(),
  }).passthrough()).default([]),
  decisionMatches: z.number().int().nonnegative().default(0),
  decisionEvaluatedCount: z.number().int().nonnegative().default(0),
  decisionCount: z.number().int().nonnegative().default(0),
  decisionAdherence: score.default(null),
  qualityIssues: z.array(z.string()),
  likeness: z.record(z.string(), z.unknown()),
  referenceSources: z.array(z.string()),
  turns: z.array(z.object({ role: z.string(), content: z.string() })),
});

const scenarioSchema = z.object({
  slug: z.string(),
  name: z.string(),
  version: z.number().nullable().optional(),
  persona: z.object({
    slug: z.string(),
    name: z.string(),
    version: z.number().nullable().optional(),
  }),
  expectedRuns: z.number().int().positive(),
  personaFidelity: score,
  sessionQuality: score,
  decisionAdherence: score.default(null),
  decisionMatches: z.number().int().nonnegative().default(0),
  decisionEvaluatedCount: z.number().int().nonnegative().default(0),
  decisionCount: z.number().int().nonnegative().default(0),
  knowledgeRetrievalRuns: z.number().int().nonnegative(),
  knowledgeSearchCount: z.number().int().nonnegative(),
  knowledgeTrackedRuns: z.number().int().nonnegative(),
  runs: z.array(runSchema),
});

export const fidelityReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("scenario-fidelity-report"),
  source: z.enum(["simulation", "session"]),
  orgId: z.string(),
  createdAt: z.string(),
  evaluationModel: z.string(),
  threshold: z.number().min(0).max(1),
  summary: z.object({
    personaFidelity: score,
    sessionQuality: score,
    completedRuns: z.number().int().nonnegative(),
    expectedRuns: z.number().int().nonnegative(),
    knowledgeRetrievalRuns: z.number().int().nonnegative(),
    knowledgeSearchCount: z.number().int().nonnegative(),
    knowledgeTrackedRuns: z.number().int().nonnegative(),
  }),
  scenarios: z.array(scenarioSchema),
});

export type FidelityReport = z.infer<typeof fidelityReportSchema>;
export type FidelityScenario = FidelityReport["scenarios"][number];
export type FidelityRun = FidelityScenario["runs"][number];

export function percentage(value: number | null | undefined) {
  return value == null ? "Not evaluated" : `${Math.round(value * 100)}%`;
}
