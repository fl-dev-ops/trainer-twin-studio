import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { learnerMinutes } from "@/lib/minutes";
import { orgName, personEmailFor } from "@/lib/invite/person-email";
import { addPeopleToOrg, LEARNER } from "@/lib/org-people";
import { queueEmails } from "@/lib/queue-emails";
import type { OutboundEmail } from "@/workflows/send-emails";

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
 * Gives a role play to people by email (the role play's Assign page and the copilot; specs/people.md): adds them to
 * the org as learners first (new ones with their starting credits; all or nothing), then a new or reopened assignment
 * gets a fresh personal link; a pending one is re-sent only on request. One email each to whoever got a link ("added"
 * too when they joined just now). The assign-roleplay workflow's first step (workflows/assign-roleplay.ts).
 */
export async function assignRoleplayLearners(input: RoleplayAssignInput) {
  const people = await addPeopleToOrg({ orgId: input.org.id, emails: input.emails, role: LEARNER, byUserId: input.by.id, startingMinutes: input.startingMinutes });
  const deployment = await ensureDeployment(input.org.id, input.agent.id);
  const assignments = await db.rolePlayAssignment.findMany({
    where: { deploymentId: deployment.id, memberId: { in: people.map((person) => person.memberId) } },
    select: { id: true, memberId: true, status: true, shareCode: true },
  });
  const assignmentByMember = new Map(assignments.map((assignment) => [assignment.memberId, assignment]));
  const stats = { added: 0, resent: 0, skipped: 0, joined: people.filter((person) => person.added).length };
  const links: Array<{ person: (typeof people)[number]; practiceUrl: string; key: string }> = [];
  const practiceUrl = (shareCode: string) => `https://${input.org.slug}.${BASE_DOMAIN}/s/${shareCode}`;

  for (const person of people) {
    const existing = assignmentByMember.get(person.memberId);
    if (!existing || existing.status === "cancelled" || existing.status === "expired") {
      const shareCode = newAssignmentShareCode();
      if (existing) {
        await db.rolePlayAssignment.update({
          where: { id: existing.id },
          data: { shareCode, status: "pending", assignedAt: new Date(), expiresAt: assignmentExpiresAt(), usedAt: null },
        });
      } else {
        await db.rolePlayAssignment.create({
          data: {
            orgId: input.org.id,
            deploymentId: deployment.id,
            memberId: person.memberId,
            assignedByUserId: input.by.id,
            shareCode,
            expiresAt: assignmentExpiresAt(),
          },
        });
      }
      stats.added++;
      links.push({ person, practiceUrl: practiceUrl(shareCode), key: `roleplay:${shareCode}` });
    } else if (existing.status === "pending" && input.resendPending) {
      stats.resent++;
      // A resend is a new email on purpose: keyed by time, not the (unchanged) link.
      links.push({ person, practiceUrl: practiceUrl(existing.shareCode), key: `roleplay:${existing.shareCode}:resend:${Date.now()}` });
    } else {
      stats.skipped++;
    }
  }

  const data = input.agent.data as { objective?: unknown } | null;
  const objective = typeof data?.objective === "string" ? data.objective : undefined;
  const upload = contextUploadFromAgentData(input.agent.data);
  const requiredArtifact = upload.required && upload.prompt ? { label: upload.label, prompt: upload.prompt } : null;
  const balances = await learnerMinutes(input.org.id, links.map(({ person }) => person.email));
  const org = { slug: input.org.slug, name: await orgName(input.org.id) };
  const emails: OutboundEmail[] = links.map(({ person, practiceUrl: url, key }) =>
    personEmailFor({
      person,
      org,
      by: input.by,
      key,
      roleplay: { name: input.agent.name, url, objective, requiredArtifact },
      balance: Math.floor(Math.max(0, balances.get(person.email)?.balanceSeconds ?? 0) / 60),
    }),
  );
  return { stats, emails };
}

/** Both parts here, without the workflow (the copilot, and when the workflow can't start): assign, then email. */
export async function inviteToRoleplay(input: RoleplayAssignInput) {
  const { stats, emails } = await assignRoleplayLearners(input);
  return { ...stats, ...(await queueEmails(input.org.id, emails)) };
}
