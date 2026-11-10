// Workflow: assign a role play.
// From a role play's Assign page: new people get their starting credits, each gets a personal practice link, and
// their emails go out through send-invite-emails (the page follows them). Run by lib/workflow-runs.ts runRoleplayAssign.

import type { RoleplayAssignInput } from "@/lib/invite/roleplay";
import { assignRoleplay, sendEmails } from "./steps/learners";

export async function assignRoleplayToLearners(input: RoleplayAssignInput) {
  "use workflow";
  const assigned = await assignRoleplay(input);
  if (!assigned.ok) return assigned;
  return { ok: true as const, ...assigned.stats, ...(await sendEmails(input.org.id, assigned.emails)) };
}
