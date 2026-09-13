import { db } from "@/lib/db";
import { MainCollectionService } from "@/lib/main-collection";
import { getAgentConfigForAgent } from "@/lib/specs";
import { buildSpecs } from "@/lib/runtime/compiler";
import { runDirectionCheck, runAnalyzerLLM } from "@/lib/runtime/openai";
import { initRuntimeState, selectAction } from "@/lib/runtime/runtime";

const orgId = "699ffaba-70fa-4fd1-a4ed-d80da8f06bff";
const agent = await db.agent.findFirstOrThrow({
  where: { slug: "project-experience-deep-dive" },
  include: { persona: true },
});
const context = await db.contextDocument.findFirst({
  where: { orgId },
  orderBy: { createdAt: "desc" },
});
const config = await getAgentConfigForAgent(agent.id, orgId, context?.id);
if (!config) throw new Error("no config");
const specs = buildSpecs(config as any);

const TURNS = [
  {
    label: "ownership-answer",
    pendingQuestion: "Greet the learner by name and start the session",
    userText: "I personally designed and led the migration of our order-processing monolith into event-driven services. I owned the architecture, broke the work into milestones, and reviewed the implementation from five engineers.",
  },
  {
    label: "mechanism-answer",
    pendingQuestion: "Can you walk me through the key technical mechanism of how you designed the event-driven architecture?",
    userText: "We used Kafka with an outbox pattern so database writes and emitted events stayed consistent. Consumers were idempotent using the order ID, and we used dead-letter queues with replay tooling for failures.",
  },
  {
    label: "impact-answer",
    pendingQuestion: "What specific user or business problem this event-driven migration was trying to solve?",
    userText: "After rollout, deployment time fell from 40 minutes to 8 minutes, order-processing failures dropped by 35 percent, and the team moved from weekly releases to daily releases.",
  },
];

console.log("=== Testing Episode Retrieval: Early/Parallel vs Context-Enriched ===");

import { invalidateCollectionCache } from "@/lib/main-collection";

const withRetry = async <T>(name: string, fn: () => Promise<T>, attempts = 4): Promise<T> => {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[test-retry] ${name} attempt ${i} failed:`, String(err));
      invalidateCollectionCache(orgId);
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
};

const comparisonResults: any[] = [];

for (const turn of TURNS) {
  const state = {
    ...initRuntimeState(),
    pending_question: turn.pendingQuestion,
    learner_turns: 1,
  };
  const transcript = [
    { role: "trainer" as const, text: turn.pendingQuestion },
    { role: "user" as const, text: turn.userText },
  ];

  // 1. EARLY QUERY (known at start of turn, without waiting for Direction or Analysis)
  const earlyQuery = [
    "Session phase: middle",
    `Learner situation: ${turn.userText.slice(0, 600)}`,
    turn.pendingQuestion ? `Pending trainer question: ${turn.pendingQuestion.slice(0, 200)}` : "",
    "Learner state: vague",
  ].filter(Boolean).join("\n");

  const t0 = performance.now();
  const earlyHitsPromise = withRetry("earlyHits", () => MainCollectionService.searchPersonaEpisodes(orgId, earlyQuery, {
    personaId: agent.persona.id,
    sessionPhase: "middle",
    limit: 3,
    diversify: true,
  }));

  // 2. IN PARALLEL: run Direction + Analysis to see what previous steps produce
  const directionPromise = runDirectionCheck(turn.userText, transcript, specs, state, []);
  
  const [earlyHits, direction] = await Promise.all([earlyHitsPromise, directionPromise]);
  const earlyMs = Math.round(performance.now() - t0);

  // Now run analysis using direction
  const analysis = await runAnalyzerLLM(turn.userText, transcript, direction, specs, state, []);
  const action = selectAction(analysis, state, specs.persona, specs.agent);

  // 3. ENRICHED QUERY (using previous step outputs: analysis.classification, direction.current_topic, action.name)
  const enrichedQuery = [
    "Session phase: middle",
    `Learner situation: ${turn.userText.slice(0, 600)}`,
    turn.pendingQuestion ? `Pending trainer question: ${turn.pendingQuestion.slice(0, 200)}` : "",
    `Learner state: ${analysis.classification || "vague"}`,
    direction.current_topic ? `Topic: ${direction.current_topic}` : "",
    `Trainer action: ${action.name}`,
  ].filter(Boolean).join("\n");

  const t1 = performance.now();
  const enrichedHits = await withRetry("enrichedHits", () => MainCollectionService.searchPersonaEpisodes(orgId, enrichedQuery, {
    personaId: agent.persona.id,
    sessionPhase: "middle",
    limit: 3,
    diversify: true,
  }));
  const enrichedMs = Math.round(performance.now() - t1);

  comparisonResults.push({
    turn: turn.label,
    early: {
      query: earlyQuery,
      latencyMs: earlyMs,
      hits: earlyHits.map((h: any) => ({ id: h.id, score: Number(h.score).toFixed(3), preview: String(h.text).slice(0, 140) })),
    },
    enriched: {
      query: enrichedQuery,
      contextAdded: {
        classification: analysis.classification,
        topic: direction.current_topic,
        action: action.name,
      },
      latencyMs: enrichedMs,
      hits: enrichedHits.map((h: any) => ({ id: h.id, score: Number(h.score).toFixed(3), preview: String(h.text).slice(0, 140) })),
    },
    overlap: `${enrichedHits.filter((eh: any) => earlyHits.some((bh: any) => bh.id === eh.id)).length} of 3 shared`,
  });
}

console.log(JSON.stringify(comparisonResults, null, 2));
await Bun.write(new URL("./episode-comparison-results.json", import.meta.url), JSON.stringify(comparisonResults, null, 2));
