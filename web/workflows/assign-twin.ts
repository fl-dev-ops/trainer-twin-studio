// Workflow: assign a twin.
// From a twin's Assign page, the copilot and the API: the people are added to the org as learners (new ones with their
// starting credits), get access to the twin, and one email each goes out through send-emails (the page follows them).
// Run by lib/workflow-runs.ts runTwinAssign.

import type { TwinAssignInput } from "@/lib/invite/twin";
import { assignTwin, sendEmails } from "./steps/learners";

export async function assignTwinToLearners(input: TwinAssignInput) {
  "use workflow";
  const assigned = await assignTwin(input);
  if (!assigned.ok) return assigned;
  return { ok: true as const, ...assigned.stats, ...(await sendEmails(input.org.id, assigned.emails)) };
}
