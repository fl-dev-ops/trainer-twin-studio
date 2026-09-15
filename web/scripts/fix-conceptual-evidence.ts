// One-off: fix the conceptual-understanding agent spec whose completion_keys were
// copied from a project-experience template and don't match its evidence keys.
// Run with: bun scripts/fix-conceptual-evidence.ts
import "dotenv/config";
import { db } from "../lib/db";
import { buildSpecs } from "../lib/runtime/compiler";
import { getAgentConfigForAgent } from "../lib/specs";

const agent = await db.agent.findFirst({ where: { slug: "conceptual-understanding" } });
if (!agent) throw new Error("Agent conceptual-understanding not found");

const data = agent.data as {
  stages: { id: string; config: { evidence?: { keys?: string[]; completion_keys?: string[]; definitions?: Record<string, unknown> } } }[];
  knowledgeBase?: string;
};
const stage = data.stages[0];
const keys = stage.config.evidence.keys ?? [];

// Validate before writing: every key must have a definition.
const missing = keys.filter((k) => !(k in (stage.config.evidence.definitions ?? {})));
if (missing.length) throw new Error(`Definitions missing for: ${missing.join(", ")} — aborting`);

stage.config.evidence.completion_keys = [...keys];

await db.agent.update({ where: { id: agent.id }, data: { data: data as object, version: { increment: 1 } } });
console.log(`✓ Updated agent conceptual-understanding → v${agent.version + 1}, completion_keys = keys`);

// Invalidate any cached broken snapshots on sessions for this agent.
const cleared = await db.interviewSession.updateMany({
  where: { agentId: agent.id },
  data: { compiledSnapshot: null as unknown as object },
});
console.log(`✓ Cleared compiledSnapshot cache on ${cleared.count} session(s)`);

// Verify: recompile fresh and run the validator.
const config = await getAgentConfigForAgent(agent.slug, agent.orgId, undefined);
try {
  buildSpecs(config!);
  console.log("✓ buildSpecs passes — prewarm will no longer throw");
} catch (err) {
  throw new Error(`buildSpecs still failing: ${err instanceof Error ? err.message : err}`);
}
