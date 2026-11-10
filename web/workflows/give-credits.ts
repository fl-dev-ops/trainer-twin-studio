// Workflow: give learners credits.
// From the Users page ("Add credits", one or many): the credits come from the org's balance, then each learner gets a
// "credits added" email through send-emails (the page follows them). Run by lib/workflow-runs.ts runGiveCredits.

import type { GiveCreditsInput } from "@/lib/invite/credits";
import { giveCredits, sendEmails } from "./steps/learners";

export async function giveCreditsToLearners(input: GiveCreditsInput) {
  "use workflow";
  const given = await giveCredits(input);
  if (!given.ok) return given;
  const { ok, emails, ...result } = given;
  return { ok, ...result, ...(await sendEmails(input.org.id, emails)) };
}
