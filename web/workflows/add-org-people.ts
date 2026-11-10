// Workflow: add people to an org.
// From Settings › Team and Users (any role; specs/people.md): each becomes a member right away (new learners with their
// starting credits), then one email each goes out through send-emails (the page follows them). Run by
// lib/workflow-runs.ts runAddOrgPeople.

import type { AddPeopleInput } from "@/lib/invite/org";
import { addPeople, sendEmails } from "./steps/learners";

export async function addPeopleToOrgFlow(input: AddPeopleInput) {
  "use workflow";
  const added = await addPeople(input);
  if (!added.ok) return added;
  const { ok, emails, ...result } = added;
  return { ok, ...result, ...(await sendEmails(input.org.id, emails)) };
}
