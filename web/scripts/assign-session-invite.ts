/**
 * Assign a published scenario to a learner by email and send the invite email,
 * mirroring the dashboard flow in app/api/role-play/[slug]/assignments/route.ts.
 *
 * Works for learners who are not org members (email-only assignment).
 * If a pending assignment already exists for that email+scenario, resends the
 * invite with the existing share code.
 *
 * Run: npx tsx scripts/assign-session-invite.ts <scenario-slug> <learner-email> [--new]
 *   --new  always create a fresh assignment row + invite (default reuses a pending one)
 */
import "dotenv/config";
import { assignmentExpiresAt, newAssignmentShareCode } from "../lib/assignments";
import { db } from "../lib/db";
import { sendRolePlayAssignmentEmail } from "../lib/email";
import { contextUploadFromAgentData } from "../lib/context-upload";

// Invite links point learners at production; override via NEXT_PUBLIC_BASE_DOMAIN for local tests.
const INVITE_BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN || "trainertwin.com";

async function main() {
  const [scenarioSlug, emailArg] = process.argv.slice(2);
  if (!scenarioSlug || !emailArg) {
    console.error("Usage: npx tsx scripts/assign-session-invite.ts <scenario-slug> <learner-email>");
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();

  const agent = await db.agent.findFirst({
    where: { slug: scenarioSlug },
    select: { id: true, name: true, slug: true, orgId: true, data: true },
  });
  if (!agent) {
    console.error(`Scenario "${scenarioSlug}" not found.`);
    process.exit(1);
  }
  const org = await db.organization.findUnique({
    where: { id: agent.orgId },
    select: { slug: true, name: true },
  });
  if (!org) {
    console.error(`Organization for scenario "${scenarioSlug}" not found.`);
    process.exit(1);
  }

  const trainer = await db.member.findFirst({
    where: { organizationId: agent.orgId, role: { in: ["admin", "team"] } },
    select: { userId: true, user: { select: { name: true } } },
  });

  const deployment = await db.deployment.findFirst({
    where: { orgId: agent.orgId, agentId: agent.id, status: "active" },
    select: { id: true },
  });
  if (!deployment) {
    console.error(`No active deployment for "${scenarioSlug}" in org "${org.slug}".`);
    process.exit(1);
  }

  const forceNew = process.argv.includes("--new");
  const existing = forceNew
    ? null
    : await db.rolePlayAssignment.findFirst({
        where: { deploymentId: deployment.id, recipientEmail: email },
        select: { id: true, shareCode: true, status: true },
      });

  let shareCode: string;
  if (existing && (existing.status === "pending" || existing.status === "in_progress")) {
    shareCode = existing.shareCode;
  } else {
    shareCode = newAssignmentShareCode();
    if (existing) {
      await db.rolePlayAssignment.update({
        where: { id: existing.id },
        data: {
          memberId: null,
          shareCode,
          status: "pending",
          assignedAt: new Date(),
          expiresAt: assignmentExpiresAt(),
          usedAt: null,
        },
      });
    } else {
      await db.rolePlayAssignment.create({
        data: {
          orgId: agent.orgId,
          deploymentId: deployment.id,
          recipientEmail: email,
          assignedByUserId: trainer?.userId,
          shareCode,
          expiresAt: assignmentExpiresAt(),
        },
      });
    }
  }

  const practiceUrl = `https://${org.slug}.${INVITE_BASE_DOMAIN}/s/${shareCode}`;
  const data = agent.data as { objective?: unknown } | null;
  const upload = contextUploadFromAgentData(agent.data);
  const requiredArtifact = upload.required && upload.prompt
    ? { label: upload.label, prompt: upload.prompt }
    : null;

  const delivery = await sendRolePlayAssignmentEmail({
    to: email,
    rolePlayName: agent.name,
    rolePlayObjective: typeof data?.objective === "string" ? data.objective : undefined,
    practiceUrl,
    trainerName: trainer?.user.name || "TrainerTwin",
    requiredArtifact,
  });

  console.log("=======================================================");
  console.log(`Scenario:    ${agent.name} (${agent.slug})`);
  console.log(`Org:         ${org.name} (${org.slug})`);
  console.log(`Learner:     ${email}`);
  console.log(`Share code:  ${shareCode}`);
  console.log(`Invite URL:  ${practiceUrl}`);
  console.log(`Email sent:  ${delivery.success ? "yes" : `no (${delivery.error})`}`);
  console.log("=======================================================");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
