import { pausedReason } from "@/lib/billing/paused";
import { db } from "@/lib/db";
import { AppError, refusals } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { learnerBalance, OUT_OF_MINUTES } from "@/lib/minutes";
import { MIN_START_MINUTES } from "@/lib/minutes-config";
import { orgCredits } from "@/lib/org-credits";
import { orgPerson, type OrgPerson } from "@/lib/org-people";
import { isStudioRole } from "@/lib/roles";

/**
 * The practice check (specs/practice.md rules 1, 4): whether this person may start a call now, and on whose credits.
 * The twin page, the link page and Start all use it, so a page never offers a Start that would be refused.
 */

type Tx = Prisma.TransactionClient | typeof db;
const whole = (seconds: number) => Math.max(0, Math.floor(seconds / 60));

/** A practice refusal (specs/practice.md Refusals). */
export class PracticeError extends AppError {}

export const practiceRefusals = {
  orgPaused: (message: string) => new PracticeError("org_paused", message, 403),
  creditsOut: () => new PracticeError("credits_out", OUT_OF_MINUTES, 403),
  creditsShort: (seconds: number) =>
    new PracticeError("credits_short", `You need at least ${MIN_START_MINUTES} minutes to start a call; you have ${whole(seconds)}. Ask your trainer for more.`, 403),
  orgCreditsOut: () => new PracticeError("org_credits_out", "Your organization has no credits left. Contact TrainerTwin to add more.", 403),
  orgCreditsShort: (seconds: number) =>
    new PracticeError("org_credits_short", `Your organization needs at least ${MIN_START_MINUTES} credits to start a call; it has ${whole(seconds)}. Contact TrainerTwin to add more.`, 403),
  voiceOnly: () => new PracticeError("voice_only", "Twin calls are voice only.", 400),
  runtimeTokenInvalid: () => new PracticeError("runtime_token_invalid", "This call is no longer available.", 401),
};

/** The person, when they are an enabled member of the org (no_org / member_disabled otherwise). */
export async function practicePerson(orgId: string, userId: string, tx: Tx = db): Promise<OrgPerson> {
  const person = await orgPerson(orgId, { userId }, tx);
  if (!person) throw refusals.noOrg();
  if (person.disabled) throw refusals.memberDisabled();
  return person;
}

/**
 * How long this person's next voice call may run, and whether it spends the org's credits (rule 4), or the refusal:
 * a paused org starts nothing; a learner needs MIN_START_MINUTES of their own credits; admin/team on a billed org
 * need as many of the org's, and are free otherwise. Inside Start's transaction (rule 5) pass its `tx`; the org
 * balance is then the last one Meteroid gave (the caller asks Meteroid for a fresh one before taking the lock).
 */
export async function startAllowance(orgId: string, person: OrgPerson, tx: Tx = db): Promise<{ allowedSeconds: number | null; chargesOrg: boolean }> {
  const studio = isStudioRole(person.role);
  const paused = await pausedReason(orgId, studio ? "studio" : "learner", tx);
  if (paused) throw practiceRefusals.orgPaused(paused);
  if (!studio) {
    const seconds = (await learnerBalance(orgId, person.email, tx)).balanceSeconds;
    if (seconds < 60) throw practiceRefusals.creditsOut();
    if (seconds < MIN_START_MINUTES * 60) throw practiceRefusals.creditsShort(seconds);
    return { allowedSeconds: seconds, chargesOrg: false };
  }
  const credits = await orgCredits(orgId, { tx });
  if (!credits.billed) return { allowedSeconds: null, chargesOrg: false };
  if (credits.seconds < 60) throw practiceRefusals.orgCreditsOut();
  if (credits.seconds < MIN_START_MINUTES * 60) throw practiceRefusals.orgCreditsShort(credits.seconds);
  return { allowedSeconds: credits.seconds, chargesOrg: true };
}
