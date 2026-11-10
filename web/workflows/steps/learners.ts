import { InviteError, inviteOrgLearners, type OrgInviteInput } from "@/lib/invite/org";
import { assignRoleplayLearners, type RoleplayAssignInput } from "@/lib/invite/roleplay";
import { assignTwinLearners, type TwinAssignInput } from "@/lib/invite/twin";
import { MinutesError } from "@/lib/minutes";
import { queueInviteEmails } from "@/lib/schedule-invite-emails";
import type { InviteEmail } from "../invite-emails";

/**
 * Steps of the assign-twin, assign-roleplay and invite-org-learners workflows (../assign-twin.ts, ../assign-roleplay.ts,
 * ../invite-org-learners.ts). None is retried: they write assignments and invitations a person is waiting on, and
 * send emails once. A refusal (not enough credits, already on the team) comes back as `{ ok: false }`.
 */

export type Refused = { ok: false; status: number; error: string };

function refused(error: unknown): Refused {
  if (error instanceof MinutesError || error instanceof InviteError) return { ok: false, status: error.status, error: error.message };
  throw error;
}

/** Starting minutes, then the twin access. */
export async function assignTwin(input: TwinAssignInput) {
  "use step";
  return assignTwinLearners(input).then((result) => ({ ok: true as const, ...result }), refused);
}
assignTwin.maxRetries = 0;

/** Starting minutes, then the role-play assignments. */
export async function assignRoleplay(input: RoleplayAssignInput) {
  "use step";
  return assignRoleplayLearners(input).then((result) => ({ ok: true as const, ...result }), refused);
}
assignRoleplay.maxRetries = 0;

/** Starting minutes, then the org invitations. */
export async function inviteLearners(input: OrgInviteInput) {
  "use step";
  return inviteOrgLearners(input).then((result) => ({ ok: true as const, ...result }), refused);
}
inviteLearners.maxRetries = 0;

/** Hands the emails to the send-invite-emails workflow (each retried there); its progress token for the screen. */
export async function sendEmails(orgId: string, emails: InviteEmail[]) {
  "use step";
  return queueInviteEmails(orgId, emails);
}
sendEmails.maxRetries = 0;
