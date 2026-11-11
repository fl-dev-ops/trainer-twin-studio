import { learnerMinutes } from "@/lib/minutes";
import { lastDay, orgName, personEmailFor } from "@/lib/invite/person-email";
import { addPeopleToOrg, LEARNER } from "@/lib/org-people";
import { queueEmails } from "@/lib/queue-emails";
import { assignTwin, twinSharePath, twinShareUrl } from "@/lib/twin-access";
import type { OutboundEmail } from "@/workflows/send-emails";

export type TwinAssignInput = {
  org: { id: string; slug: string };
  by: { id: string; name: string };
  agent: { id: string; name: string };
  emails: string[];
  accessUntil?: Date | null;
  /** Credits each new person starts with (default DEFAULT_LEARNER_MINUTES); people who already have credits keep theirs. */
  startingMinutes?: number;
};

/**
 * Gives a twin to people by email (specs/people.md): adds them to the org as learners first (new ones with their
 * starting credits; all or nothing), then assigns the twin, then one email each to whoever got new or restored access
 * ("added" too when they joined just now). The assign-twin workflow's first step (workflows/assign-twin.ts).
 */
export async function assignTwinLearners(input: TwinAssignInput) {
  // People and their assignments in one locked transaction (specs/practice.md rule 10): all or nothing.
  let assigned: Awaited<ReturnType<typeof assignTwin>> | undefined;
  const people = await addPeopleToOrg({
    orgId: input.org.id,
    emails: input.emails,
    role: LEARNER,
    byUserId: input.by.id,
    startingMinutes: input.startingMinutes,
    then: async (tx, added) => {
      assigned = await assignTwin({
        orgId: input.org.id,
        agentId: input.agent.id,
        people: added.map(({ userId, email }) => ({ userId, email })),
        accessUntil: input.accessUntil,
        assignedByUserId: input.by.id,
      }, tx);
    },
  });
  const { stats, invites } = assigned ?? { stats: { added: 0, reactivated: 0, skipped: 0 }, invites: [] };
  const byEmail = new Map(people.map((person) => [person.email, person]));
  const balances = await learnerMinutes(input.org.id, invites.map((invite) => invite.to));
  const org = { slug: input.org.slug, name: await orgName(input.org.id) };
  // The readable twin link: access is the signed-in member's own assignment (lib/pages/learner.ts).
  const url = twinShareUrl(input.org.slug, await twinSharePath(input.org.id, input.org.slug, input.agent.id));
  const emails: OutboundEmail[] = invites.map(({ to, shareCode }) =>
    personEmailFor({
      person: byEmail.get(to)!,
      org,
      by: input.by,
      key: `twin:${shareCode}`,
      twin: { name: input.agent.name, url, until: lastDay(input.accessUntil) },
      balance: Math.floor(Math.max(0, balances.get(to)?.balanceSeconds ?? 0) / 60),
    }),
  );
  return { stats: { ...stats, joined: people.filter((person) => person.added).length }, emails };
}

/** Both parts here, without the workflow (the copilot, and when the workflow can't start): assign, then email. */
export async function assignTwinAndInvite(input: TwinAssignInput) {
  const { stats, emails } = await assignTwinLearners(input);
  return { ...stats, ...(await queueEmails(input.org.id, emails)) };
}
