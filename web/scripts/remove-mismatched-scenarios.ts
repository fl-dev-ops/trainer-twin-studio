/**
 * Lists, and with --apply deletes, an organization's scenarios that do not match
 * its type (role plays in a technical interview org, interview scenarios in a
 * sales org), together with their sessions. Deployments and assignments go with
 * the scenario (cascade). Recordings in S3 are left in place.
 *
 * Usage: bun scripts/remove-mismatched-scenarios.ts <org-slug> [--apply]
 */
import { db } from "../lib/db";
import { scenarioFitsOrg, scenarioKindOf } from "../lib/org-type";

const slug = process.argv[2];
const apply = process.argv.includes("--apply");
if (!slug) {
  console.error("Usage: bun scripts/remove-mismatched-scenarios.ts <org-slug> [--apply]");
  process.exit(1);
}

const org = await db.organization.findUnique({ where: { slug }, select: { id: true, type: true } });
if (!org) {
  console.error(`No organization with slug "${slug}".`);
  process.exit(1);
}

const agents = await db.agent.findMany({
  where: { orgId: org.id },
  select: { id: true, slug: true, data: true, _count: { select: { sessions: true } } },
});
const mismatched = agents.filter((agent) => !scenarioFitsOrg(org.type, agent.data));

console.log(`${slug} (${org.type}): ${mismatched.length} of ${agents.length} scenario(s) do not match`);
for (const agent of mismatched) {
  console.log(`  ${agent.slug}  [${scenarioKindOf(agent.data)}]  ${agent._count.sessions} session(s)`);
}

if (!apply || mismatched.length === 0) {
  if (mismatched.length) console.log("Dry run. Re-run with --apply to delete them.");
  process.exit(0);
}

const ids = mismatched.map((agent) => agent.id);
const [sessions, removed] = await db.$transaction([
  db.interviewSession.deleteMany({ where: { orgId: org.id, agentId: { in: ids } } }),
  db.agent.deleteMany({ where: { orgId: org.id, id: { in: ids } } }),
]);
console.log(`Deleted ${removed.count} scenario(s) and ${sessions.count} session(s).`);
process.exit(0);
