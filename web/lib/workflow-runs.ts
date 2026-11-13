import { start } from "workflow/api";
import { giveLearnerCreditsAndEmail, type GiveCreditsInput } from "@/lib/invite/credits";
import { addOrgPeopleAndEmail, type AddPeopleInput } from "@/lib/invite/org";
import { inviteToRoleplay, type RoleplayAssignInput } from "@/lib/invite/roleplay";
import { assignTwinAndInvite, type TwinAssignInput } from "@/lib/invite/twin";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { db } from "@/lib/db";
import { AppError, refusedOf, type Refused } from "@/lib/errors";
import { grantTrialMinutes, linkOrgToMeteroid } from "@/lib/org-billing-setup";
import { assignRoleplayToLearners } from "@/workflows/assign-roleplay";
import { assignTwinToLearners } from "@/workflows/assign-twin";
import { addPeopleToOrgFlow } from "@/workflows/add-org-people";
import { giveCreditsToLearners } from "@/workflows/give-credits";
import { onboardOrg } from "@/workflows/onboard-org";

/**
 * Runs the workflows a person waits on (web/workflows/*): adding people, assigning twins and role plays, giving credits,
 * onboarding an org (and, in lib/run-session-start.ts, starting a call). Each waits for its result. When a workflow
 * can't start, the same parts run right here, so nothing a person does is blocked by the workflow runtime.
 */

// Someone is waiting: check for a workflow's result every 100 ms (the SDK's default is 1 s).
process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS ??= "100";

export async function runAndWait<A extends unknown[], R>(name: string, workflow: (...args: A) => Promise<R>, args: A, direct: (...args: A) => Promise<R>): Promise<R> {
  let run;
  try {
    run = await start(workflow, args);
  } catch (error) {
    console.error(`[${name}] workflow did not start; running here:`, error instanceof Error ? error.message : error);
    return direct(...args);
  }
  return run.returnValue as Promise<R>;
}

/** A refusal from a workflow, thrown again as our error (AppError) with its code, status and message. */
function orThrow<T extends { ok: boolean }>(result: T | Refused): Extract<T, { ok: true }> {
  if (!result.ok) {
    const refusal = result as Refused;
    throw new AppError(refusal.code, refusal.error, refusal.status);
  }
  const rest: Record<string, unknown> = { ...result };
  delete rest.ok;
  return rest as unknown as Extract<T, { ok: true }>;
}

const direct = <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
  (...args: A) => run(...args).then((value) => ({ ok: true as const, ...value }), refusedOf);

/** Twin Assign page (workflows/assign-twin.ts). Throws our refusal (AppError) when refused. */
export async function runTwinAssign(input: TwinAssignInput) {
  return orThrow(await runAndWait("assign-twin", assignTwinToLearners, [input], direct(assignTwinAndInvite)));
}

/** Role-play Assign page (workflows/assign-roleplay.ts). Throws our refusal (AppError) when refused. */
export async function runRoleplayAssign(input: RoleplayAssignInput) {
  return orThrow(await runAndWait("assign-roleplay", assignRoleplayToLearners, [input], direct(inviteToRoleplay)));
}

/** Settings › Team and Users (workflows/add-org-people.ts). Throws our refusal (AppError) when refused. */
export async function runAddOrgPeople(input: AddPeopleInput) {
  return orThrow(await runAndWait("add-org-people", addPeopleToOrgFlow, [input], direct(addOrgPeopleAndEmail)));
}

/** Users page "Add credits" (workflows/give-credits.ts). Throws our refusal (AppError) when refused. */
export async function runGiveCredits(input: GiveCreditsInput) {
  return orThrow(await runAndWait("give-credits", giveCreditsToLearners, [input], direct(giveLearnerCreditsAndEmail)));
}

/** Founder onboarding (workflows/onboard-org.ts): the org's Chroma database, Meteroid customer and trial credits. */
export async function runOnboarding(orgId: string) {
  return runAndWait("onboard-org", onboardOrg, [orgId], async (id: string) => {
    await ChromaTenantService.createOrgDatabase(id);
    if (!process.env.METEROID_API_KEY?.trim()) return { ok: true as const, meteroidCustomerId: null };
    const org = await db.organization.findUniqueOrThrow({ where: { id }, select: { id: true, slug: true, name: true, createdAt: true } });
    const { customerId } = await linkOrgToMeteroid(org);
    await grantTrialMinutes(org, customerId);
    return { ok: true as const, meteroidCustomerId: customerId };
  });
}
