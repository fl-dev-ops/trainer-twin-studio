import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { sendRolePlayAssignmentEmail } from "@/lib/email";

/**
 * Invites learners to a role play by email (the role play's Assign page and the copilot): a new or reopened
 * assignment gets a fresh personal link and an email; a pending one is re-sent only on request. People may belong
 * to several orgs.
 */
export async function inviteToRoleplay(input: {
  org: { id: string; slug: string };
  by: { id: string; name: string };
  agent: { id: string; name: string; data: unknown };
  emails: string[];
  resendPending?: boolean;
}) {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))];
  const deployment = await ensureDeployment(input.org.id, input.agent.id);
  const assignments = await db.rolePlayAssignment.findMany({
    where: { deploymentId: deployment.id, recipientEmail: { in: emails } },
    select: { id: true, recipientEmail: true, status: true, shareCode: true },
  });
  const assignmentByEmail = new Map(assignments.map((assignment) => [assignment.recipientEmail, assignment]));
  const stats = { added: 0, resent: 0, skipped: 0 };
  const assignmentEmails: Array<{ to: string; practiceUrl: string }> = [];
  const practiceUrl = (shareCode: string) => `https://${input.org.slug}.${BASE_DOMAIN}/s/${shareCode}`;

  for (const email of emails) {
    const existing = assignmentByEmail.get(email);
    if (!existing || existing.status === "cancelled" || existing.status === "expired") {
      const shareCode = newAssignmentShareCode();
      if (existing) {
        await db.rolePlayAssignment.update({
          where: { id: existing.id },
          data: { memberId: null, shareCode, status: "pending", assignedAt: new Date(), expiresAt: assignmentExpiresAt(), usedAt: null },
        });
      } else {
        await db.rolePlayAssignment.create({
          data: {
            orgId: input.org.id,
            deploymentId: deployment.id,
            recipientEmail: email,
            assignedByUserId: input.by.id,
            shareCode,
            expiresAt: assignmentExpiresAt(),
          },
        });
      }
      stats.added++;
      assignmentEmails.push({ to: email, practiceUrl: practiceUrl(shareCode) });
    } else if (existing.status === "pending" && input.resendPending) {
      stats.resent++;
      assignmentEmails.push({ to: email, practiceUrl: practiceUrl(existing.shareCode) });
    } else {
      stats.skipped++;
    }
  }

  const data = input.agent.data as { objective?: unknown } | null;
  const objective = typeof data?.objective === "string" ? data.objective : undefined;
  const upload = contextUploadFromAgentData(input.agent.data);
  const requiredArtifact = upload.required && upload.prompt ? { label: upload.label, prompt: upload.prompt } : null;
  const deliveries = await Promise.all(
    assignmentEmails.map(({ to, practiceUrl: url }) =>
      sendRolePlayAssignmentEmail({
        to,
        rolePlayName: input.agent.name,
        rolePlayObjective: objective,
        practiceUrl: url,
        trainerName: input.by.name,
        requiredArtifact,
      }),
    ),
  );
  return { ...stats, emailFailures: deliveries.filter(({ success }) => !success).length };
}
