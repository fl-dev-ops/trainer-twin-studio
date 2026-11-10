import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { giveStartingMinutes, learnerMinutes } from "@/lib/minutes";
import { queueInviteEmails } from "@/lib/schedule-invite-emails";
import type { InviteEmail } from "@/workflows/invite-emails";

export type RoleplayAssignInput = {
  org: { id: string; slug: string };
  by: { id: string; name: string };
  agent: { id: string; name: string; data: unknown };
  emails: string[];
  resendPending?: boolean;
  /** Credits each new person starts with (default DEFAULT_LEARNER_MINUTES); people who already have credits keep theirs. */
  startingMinutes?: number;
};

/**
 * Assigns a role play by email (the role play's Assign page and the copilot): new people get their starting minutes
 * (refused with MinutesError when the org balance is short); a new or reopened assignment gets a fresh personal link;
 * a pending one is re-sent only on request. Returns what happened and the emails to send. The assign-roleplay
 * workflow's first step (workflows/assign-roleplay.ts). People may belong to several orgs.
 */
export async function assignRoleplayLearners(input: RoleplayAssignInput) {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))];
  // New people get their starting credits (all or nothing: refused when the org balance is short).
  await giveStartingMinutes({ orgId: input.org.id, emails, minutes: input.startingMinutes, actorUserId: input.by.id });
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
  const balances = await learnerMinutes(input.org.id, assignmentEmails.map(({ to }) => to));
  const inviteEmails: InviteEmail[] = assignmentEmails.map(({ to, practiceUrl: url }) => ({
    kind: "roleplay" as const,
    args: {
      to,
      rolePlayName: input.agent.name,
      rolePlayObjective: objective,
      practiceUrl: url,
      trainerName: input.by.name,
      requiredArtifact,
      minutes: Math.floor(Math.max(0, balances.get(to)?.balanceSeconds ?? 0) / 60),
    },
  }));
  return { stats, emails: inviteEmails };
}

/** Both parts here, without the workflow (the copilot, and when the workflow can't start): assign, then email. */
export async function inviteToRoleplay(input: RoleplayAssignInput) {
  const { stats, emails } = await assignRoleplayLearners(input);
  return { ...stats, ...(await queueInviteEmails(input.org.id, emails)) };
}
