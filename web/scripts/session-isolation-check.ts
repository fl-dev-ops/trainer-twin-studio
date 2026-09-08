import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { activateSession, authorizeRuntimeSession, createAssignedSession } from "../lib/interview-sessions";
import { db } from "../lib/db";

const agent = await db.agent.findFirst({
  where: { orgId: { not: null } },
  select: { id: true, orgId: true },
});
assert(agent?.orgId, "expected one configured agent");
const members = await db.member.findMany({
  where: { organizationId: agent.orgId },
  select: { userId: true },
  take: 2,
});
assert(members.length >= 2, "expected two members for the isolation check");
const assigned = await createAssignedSession({ orgId: agent.orgId, userId: members[0].userId, agentId: agent.id });
try {
  assert.equal(await activateSession({ orgId: agent.orgId, userId: members[1].userId, shareCode: assigned.shareCode }), null);
  const active = await activateSession({ orgId: agent.orgId, userId: members[0].userId, shareCode: assigned.shareCode });
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
  await db.interviewSession.delete({ where: { id: assigned.id } });
}
