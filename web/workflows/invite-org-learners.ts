// Workflow: invite learners to the org.
// From Settings › Users: new people get their starting credits, each gets an org invitation (48 h), and the
// invitation emails go out through send-invite-emails (the page follows them). Run by lib/workflow-runs.ts runOrgInvite.

import type { OrgInviteInput } from "@/lib/invite/org";
import { inviteLearners, sendEmails } from "./steps/learners";

export async function inviteOrgLearners(input: OrgInviteInput) {
  "use workflow";
  const invited = await inviteLearners(input);
  if (!invited.ok) return invited;
  const { ok, emails, ...result } = invited;
  return { ok, ...result, ...(await sendEmails(input.org.id, emails)) };
}
