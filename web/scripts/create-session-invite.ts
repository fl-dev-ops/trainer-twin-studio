import { db } from "../lib/db";
import { newAssignmentShareCode, assignmentExpiresAt } from "../lib/assignments";

async function main() {
  const scenarioSlug = process.argv[2] || "resume-defense-cross-examination";
  const userEmail = process.argv[3] || "admin@acme.com";

  const user = await db.user.findUnique({
    where: { email: userEmail },
    include: {
      members: {
        include: { organization: true },
      },
    },
  });

  if (!user || user.members.length === 0) {
    console.error(`User ${userEmail} not found or has no organization.`);
    process.exit(1);
  }

  const member = user.members[0];
  const org = member.organization;

  // Find deployment for this scenario
  const deployment = await db.deployment.findFirst({
    where: {
      orgId: org.id,
      agent: { slug: scenarioSlug },
      status: "active",
    },
    include: {
      agent: true,
    },
  });

  if (!deployment) {
    console.error(`Active deployment for scenario "${scenarioSlug}" in org "${org.slug}" not found.`);
    process.exit(1);
  }

  const shareCode = newAssignmentShareCode();
  const expiresAt = assignmentExpiresAt();

  // One assignment per deployment+member (unique constraint).
  // If a previous one exists with completed sessions, detach them so this invite is fresh.
  const existing = await db.rolePlayAssignment.findFirst({
    where: { deploymentId: deployment.id, memberId: member.id },
    select: { id: true },
  });
  if (existing) {
    await db.interviewSession.updateMany({
      where: { assignmentId: existing.id },
      data: { assignmentId: null },
    });
  }

  const assignment = existing
    ? await db.rolePlayAssignment.update({
        where: { id: existing.id },
        data: { shareCode, status: "pending", assignedAt: new Date(), expiresAt, usedAt: null },
      })
    : await db.rolePlayAssignment.create({
        data: {
          orgId: org.id,
          deploymentId: deployment.id,
          memberId: member.id,
          assignedByUserId: user.id,
          shareCode,
          status: "pending",
          expiresAt,
        },
      });

  console.log("\n=======================================================");
  console.log("            NEW SESSION INVITE CREATED                 ");
  console.log("=======================================================");
  console.log(`Scenario:     ${deployment.agent.name} (${deployment.agent.slug})`);
  console.log(`Assigned To:  ${user.name} (${user.email})`);
  console.log(`Organization: ${org.name} (${org.slug})`);
  console.log(`Share Code:   ${assignment.shareCode}`);
  console.log(`Status:       ${assignment.status}`);
  console.log(`Expires:      ${assignment.expiresAt.toISOString()}`);
  console.log("-------------------------------------------------------");
  console.log("Local URL (dev):");
  console.log(`  http://${org.slug}.trainertwin.localhost:3000/s/${assignment.shareCode}`);
  console.log("Production URL:");
  console.log(`  https://${org.slug}.trainertwin.com/s/${assignment.shareCode}`);
  console.log("=======================================================\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
