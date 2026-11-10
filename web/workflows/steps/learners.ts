import { giveLearnerCredits, type GiveCreditsInput } from "@/lib/invite/credits";
import { addOrgPeople, type AddPeopleInput } from "@/lib/invite/org";
import { assignRoleplayLearners, type RoleplayAssignInput } from "@/lib/invite/roleplay";
import { assignTwinLearners, type TwinAssignInput } from "@/lib/invite/twin";
import { MinutesError } from "@/lib/minutes";
import { PeopleError } from "@/lib/org-people";
import { queueEmails } from "@/lib/queue-emails";
import type { OutboundEmail } from "../send-emails";

/**
 * Steps of the add-org-people, assign-twin, assign-roleplay and give-credits workflows (../add-org-people.ts,
 * ../assign-twin.ts, ../assign-roleplay.ts, ../give-credits.ts). None is retried: they write memberships, assignments
 * and credits a person is waiting on, and send emails once. A refusal (not enough credits, a disabled or studio
 * person, a second admin) comes back as `{ ok: false }`.
 */

export type Refused = { ok: false; status: number; error: string };

function refused(error: unknown): Refused {
  if (error instanceof MinutesError || error instanceof PeopleError) return { ok: false, status: error.status, error: error.message };
  throw error;
}

/** Adds the people to the org as learners, then the twin access. */
export async function assignTwin(input: TwinAssignInput) {
  "use step";
  return assignTwinLearners(input).then((result) => ({ ok: true as const, ...result }), refused);
}
assignTwin.maxRetries = 0;

/** Adds the people to the org as learners, then the role-play assignments. */
export async function assignRoleplay(input: RoleplayAssignInput) {
  "use step";
  return assignRoleplayLearners(input).then((result) => ({ ok: true as const, ...result }), refused);
}
assignRoleplay.maxRetries = 0;

/** Adds the people to the org with their role (learners with their starting credits). */
export async function addPeople(input: AddPeopleInput) {
  "use step";
  return addOrgPeople(input).then((result) => ({ ok: true as const, ...result }), refused);
}
addPeople.maxRetries = 0;

/** Gives learners credits. */
export async function giveCredits(input: GiveCreditsInput) {
  "use step";
  return giveLearnerCredits(input).then((result) => ({ ok: true as const, ...result }), refused);
}
giveCredits.maxRetries = 0;

/** Hands the emails to the send-emails workflow (each retried there); its progress token for the screen. */
export async function sendEmails(orgId: string, emails: OutboundEmail[]) {
  "use step";
  return queueEmails(orgId, emails);
}
sendEmails.maxRetries = 0;
