import { learnerMinutes } from "@/lib/minutes";
import { orgName, personEmailFor } from "@/lib/invite/person-email";
import { addPeopleToOrg, LEARNER, orgPeople, type PersonRole } from "@/lib/org-people";
import { deliverEmail, queueEmails } from "@/lib/queue-emails";
import type { OutboundEmail } from "@/workflows/send-emails";

/**
 * Adding people to an org (specs/people.md): Settings › Team and Users (any role) and the REST API (learners). They
 * become members right away and just sign in; each new member gets one email (added, plus their credits for learners).
 */

export type AddPeopleInput = {
  org: { id: string; slug: string; name: string };
  by: { id: string; name: string };
  emails: string[];
  role: PersonRole;
  /** Starting credits for new learners (default DEFAULT_LEARNER_MINUTES). */
  minutes?: number;
};

/** One "added" email per new member; the key makes it go out once per membership. */
async function addedEmails(org: AddPeopleInput["org"], by: AddPeopleInput["by"], people: Awaited<ReturnType<typeof addPeopleToOrg>>) {
  const fresh = people.filter((person) => person.added);
  const balances = await learnerMinutes(org.id, fresh.filter((person) => person.role === LEARNER).map((person) => person.email));
  return fresh.map((person): OutboundEmail =>
    personEmailFor({
      person,
      org,
      by,
      key: `added:${person.memberId}`,
      balance: person.role === LEARNER ? Math.floor(Math.max(0, balances.get(person.email)?.balanceSeconds ?? 0) / 60) : undefined,
    }),
  );
}

/**
 * Adds people with a role (refused all or nothing: PeopleError, or MinutesError when the org can't cover new learners'
 * starting credits). Returns counts and the emails to send. The add-org-people workflow's first step.
 */
export async function addOrgPeople(input: AddPeopleInput) {
  const people = await addPeopleToOrg({ orgId: input.org.id, emails: input.emails, role: input.role, byUserId: input.by.id, startingMinutes: input.minutes });
  const added = people.filter((person) => person.added).length;
  return { added, already: people.length - added, emails: await addedEmails(input.org, input.by, people) };
}

/** Both parts here, without the workflow (when it can't start): add, then email. */
export async function addOrgPeopleAndEmail(input: AddPeopleInput) {
  const { emails, ...result } = await addOrgPeople(input);
  return { ...result, ...(await queueEmails(input.org.id, emails)) };
}

/**
 * REST API (POST /api/v1/users): adds one learner as the API key's trainer (or the org's admin), emails them now (with
 * background retries), and returns them. Someone already a learner comes back unchanged (`created: false`).
 */
export async function addLearnerByApi(input: { org: { id: string; slug: string }; actorUserId?: string | null; email: string }) {
  const studio = await orgPeople(input.org.id, { roles: ["admin", "team"], ...(input.actorUserId ? { userIds: [input.actorUserId] } : {}) });
  const by = studio[0];
  if (!by) throw new ApiAddError("API key creator is no longer an organization trainer", 403);
  const org = { ...input.org, name: await orgName(input.org.id) };
  const [person] = await addPeopleToOrg({ orgId: org.id, emails: [input.email], role: LEARNER, byUserId: by.userId });
  const [email] = await addedEmails(org, { id: by.userId, name: by.name }, [person]);
  const delivery = email ? await deliverEmail({ ...email, idempotencyKey: email.idempotencyKey! }) : { sent: false };
  return { person, created: person.added, emailSent: delivery.sent };
}

export class ApiAddError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
