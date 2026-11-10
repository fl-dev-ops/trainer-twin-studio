import { giveStartingMinutes, learnerMinutes } from "@/lib/minutes";
import { queueAssignmentEmails } from "@/lib/schedule-assignment-emails";
import { assignTwin, twinSharePath, twinShareUrl } from "@/lib/twin-access";

/**
 * Gives new people their starting minutes (all or nothing: refused when the org balance is short), then assignTwin,
 * then emails each new or reactivated learner their link with the minutes they have (a workflow: `emailProgress`).
 */
export async function assignTwinAndInvite(input: {
  org: { id: string; slug: string };
  by: { id: string; name: string };
  agent: { id: string; name: string };
  emails: string[];
  accessUntil?: Date | null;
  /** Credits each new person starts with (default DEFAULT_LEARNER_MINUTES); people who already have credits keep theirs. */
  startingMinutes?: number;
}) {
  await giveStartingMinutes({ orgId: input.org.id, emails: input.emails, minutes: input.startingMinutes, actorUserId: input.by.id });
  const { stats, invites } = await assignTwin({
    orgId: input.org.id,
    agentId: input.agent.id,
    emails: input.emails,
    accessUntil: input.accessUntil,
    assignedByUserId: input.by.id,
  });
  const balances = await learnerMinutes(input.org.id, invites.map((invite) => invite.to));
  // The readable twin link: the personal /s/<code> link would work too, but the assignment is already bound to
  // the invited email, so matching it by sign-in (lib/pages/learner.ts) is all the learner needs.
  const sharePath = await twinSharePath(input.org.id, input.org.slug, input.agent.id);
  const emails = await queueAssignmentEmails(input.org.id, invites.map(({ to }) => ({
    kind: "twin" as const,
    args: {
      to,
      twinName: input.agent.name,
      minutes: Math.floor((balances.get(to)?.balanceSeconds ?? 0) / 60),
      practiceUrl: twinShareUrl(input.org.slug, sharePath),
      trainerName: input.by.name,
    },
  })));
  return { ...stats, ...emails };
}
