import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import type { Prisma } from "@/lib/generated/prisma/client";
import { ensureDeployment } from "@/lib/deployments";
import { learnerMinutes } from "@/lib/minutes";
import { orgName, personEmailFor } from "@/lib/invite/person-email";
import { addPeopleToOrg, LEARNER, type AddedPerson } from "@/lib/org-people";
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
  const deployment = await ensureDeployment(input.org.id, input.agent.id);
  const practiceUrl = (shareCode: string) => `https://${input.org.slug}.${BASE_DOMAIN}/s/${shareCode}`;
  let given: Awaited<ReturnType<typeof giveRoleplay<AddedPerson>>> = { links: [], stats: { added: 0, resent: 0, skipped: 0 } };
  // People and their links in one locked transaction (specs/practice.md rule 19): all or nothing.
  const people = await addPeopleToOrg({
    orgId: input.org.id,
    emails: input.emails,
    role: LEARNER,
    byUserId: input.by.id,
    startingMinutes: input.startingMinutes,
    then: async (tx, added) => {
      given = await giveRoleplay(tx, { orgId: input.org.id, deploymentId: deployment.id, people: added, byUserId: input.by.id, resendPending: input.resendPending });
    },
  });
  const stats = { ...given.stats, joined: people.filter((person) => person.added).length };
  const links = given.links.map((link) => ({ ...link, practiceUrl: practiceUrl(link.shareCode) }));

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

/**
 * The role-play links of people already in the org (specs/practice.md rule 19), in the caller's locked transaction:
 * a new or reopened (cancelled, expired) link gets a fresh code; an open one is re-sent only on request; others are
 * left as they are. Returns who should be emailed.
 */
export async function giveRoleplay<P extends { memberId: string }>(
  tx: Prisma.TransactionClient,
  input: { orgId: string; deploymentId: string; people: P[]; byUserId: string; resendPending?: boolean },
) {
  const existing = new Map((await tx.rolePlayAssignment.findMany({
    where: { deploymentId: input.deploymentId, memberId: { in: input.people.map((person) => person.memberId) } },
    select: { id: true, memberId: true, status: true, shareCode: true },
  })).map((row) => [row.memberId, row]));
  const stats = { added: 0, resent: 0, skipped: 0 };
  const links: Array<{ person: P; shareCode: string; key: string; assignmentId: string }> = [];
  for (const person of input.people) {
    const current = existing.get(person.memberId);
    if (!current || current.status === "cancelled" || current.status === "expired") {
      const shareCode = newAssignmentShareCode();
      const row = current
        ? await tx.rolePlayAssignment.update({
            where: { id: current.id },
            data: { shareCode, status: "pending", assignedAt: new Date(), expiresAt: assignmentExpiresAt(), usedAt: null },
            select: { id: true },
          })
        : await tx.rolePlayAssignment.create({
            data: { orgId: input.orgId, deploymentId: input.deploymentId, memberId: person.memberId, assignedByUserId: input.byUserId, shareCode, expiresAt: assignmentExpiresAt() },
            select: { id: true },
          });
      stats.added++;
      links.push({ person, shareCode, key: `roleplay:${shareCode}`, assignmentId: row.id });
    } else if (input.resendPending) {
      stats.resent++;
      // A resend is a new email on purpose: keyed by time, not the (unchanged) link.
      links.push({ person, shareCode: current.shareCode, key: `roleplay:${current.shareCode}:resend:${Date.now()}`, assignmentId: current.id });
    } else {
      stats.skipped++;
    }
  }
  return { stats, links };
}
