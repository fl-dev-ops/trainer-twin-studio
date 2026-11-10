import { grantMinutesToMany, learnerMinutes } from "@/lib/minutes";
import { orgName, personEmailFor } from "@/lib/invite/person-email";
import { LEARNER, orgPeople } from "@/lib/org-people";
import { queueEmails } from "@/lib/queue-emails";
import type { OutboundEmail } from "@/workflows/send-emails";

export type GiveCreditsInput = {
  org: { id: string; slug: string };
  by: { id: string; name: string };
  emails: string[];
  minutes: number;
  note?: string | null;
};

/**
 * Adds the same credits to some of the org's learners (the Users page), from the org's balance, then one "credits
 * added" email each (specs/people.md rule 11). Anyone not a learner here (admin and team practise from the org's
 * credits; others aren't in the org) or past the per-learner cap is skipped with the reason; the rest are all given,
 * or none when the org balance is short (MinutesError). The give-credits workflow's first step.
 */
export async function giveLearnerCredits(input: GiveCreditsInput) {
  const wanted = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))];
  const people = await orgPeople(input.org.id, { emails: wanted, includeDisabled: true });
  const byEmail = new Map(people.map((person) => [person.email, person]));
  const skipped: { email: string; reason: string }[] = [];
  const learners: string[] = [];
  for (const email of wanted) {
    const person = byEmail.get(email);
    if (!person) skipped.push({ email, reason: "is not in this organization" });
    else if (person.role !== LEARNER) skipped.push({ email, reason: "is on the studio team (their calls use the organization's credits)" });
    else if (person.disabled) skipped.push({ email, reason: "is disabled" });
    else learners.push(email);
  }
  const result = learners.length
    ? await grantMinutesToMany({ orgId: input.org.id, emails: learners, minutes: input.minutes, actorUserId: input.by.id, note: input.note || "Added by trainer" })
    : { given: [] as string[], skipped: [] as { email: string; reason: string }[], orgBalanceMinutes: null };

  const balances = await learnerMinutes(input.org.id, result.given);
  const org = { slug: input.org.slug, name: await orgName(input.org.id) };
  const stamp = Date.now();
  const emails: OutboundEmail[] = result.given.map((email) =>
    personEmailFor({
      person: { ...byEmail.get(email)!, added: false, startingCredits: 0 },
      org,
      by: input.by,
      // Each grant is its own event: keyed by this request, so a workflow retry can't send it twice.
      key: `credits:${input.org.id}:${email}:${stamp}`,
      balance: Math.floor(Math.max(0, balances.get(email)?.balanceSeconds ?? 0) / 60),
      creditsAdded: input.minutes,
    }),
  );
  return { given: result.given, skipped: [...skipped, ...result.skipped], orgBalanceMinutes: result.orgBalanceMinutes, emails };
}

/** Both parts here, without the workflow (when it can't start): give, then email. */
export async function giveLearnerCreditsAndEmail(input: GiveCreditsInput) {
  const { emails, ...result } = await giveLearnerCredits(input);
  return { ...result, ...(await queueEmails(input.org.id, emails)) };
}
