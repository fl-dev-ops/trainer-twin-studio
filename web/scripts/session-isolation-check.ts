import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assignmentExpiresAt, newAssignmentShareCode } from "../lib/assignments";
import { ensureDeployment } from "../lib/deployments";
import { activateSession, authorizeRuntimeSession } from "../lib/interview-sessions";
import { db } from "../lib/db";

const agent = await db.agent.findFirst({
  where: { orgId: { not: null } },
  select: { id: true, orgId: true },
});
assert(agent?.orgId, "expected one configured agent");
const members = await db.member.findMany({
  where: { organizationId: agent.orgId },
  select: { id: true, userId: true },
  take: 2,
});
assert(members.length >= 2, "expected two members for the isolation check");
const deployment = await ensureDeployment(agent.orgId, agent.id);
const assignment = await db.rolePlayAssignment.create({
  data: {
    orgId: agent.orgId,
    deploymentId: deployment.id,
    memberId: members[0].id,
    assignedByUserId: members[0].userId,
    shareCode: newAssignmentShareCode(),
    expiresAt: assignmentExpiresAt(),
  },
});
try {
  assert.equal(await activateSession({ orgId: agent.orgId, userId: members[1].userId, shareCode: assignment.shareCode }), null);
  const active = await activateSession({ orgId: agent.orgId, userId: members[0].userId, shareCode: assignment.shareCode });
  assert(active?.runtimeToken);
  assert.equal(await authorizeRuntimeSession(active.id, "wrong-token"), null);
  assert.equal((await authorizeRuntimeSession(active.id, active.runtimeToken))?.userId, members[0].userId);
  const outsider = await db.member.findFirst({
    where: { organizationId: { not: agent.orgId } },
    select: { organizationId: true, userId: true },
  });
  if (outsider) {
    await assert.rejects(db.interviewSession.create({
      data: {
        orgId: outsider.organizationId,
        userId: outsider.userId,
        agentId: agent.id,
        shareCode: randomUUID().slice(0, 12),
        personaSlug: "invalid",
        personaVersion: 1,
        agentSlug: "invalid",
        agentVersion: 1,
        domainSlug: "invalid",
        domainVersion: 1,
      },
    }));
  }
  console.log("session URL, runtime-token, and cross-org DB checks passed");
} finally {
  await db.interviewSession.deleteMany({ where: { assignmentId: assignment.id } });
  await db.rolePlayAssignment.delete({ where: { id: assignment.id } });
}
