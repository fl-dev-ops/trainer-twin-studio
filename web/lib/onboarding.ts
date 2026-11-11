import { randomUUID } from "node:crypto";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { db, isUniqueViolation } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { unlinkOrgFromMeteroid } from "@/lib/org-billing-setup";
import { validateOrgSlug } from "@/lib/slugs";
import { runOnboarding } from "@/lib/workflow-runs";

/** Founder onboarding refusals (specs/people.md Refusals). */
export const onboardingRefusals = {
  tokenInvalid: () => new AppError("token_invalid", "This setup link is invalid or already used.", 400),
  tokenEmailMismatch: () => new AppError("token_email_mismatch", "This setup link is for a different email address.", 403),
  slugInvalid: (why: string) => new AppError("slug_invalid", why, 400),
  slugTaken: () => new AppError("slug_taken", "That subdomain is taken.", 409),
  failed: () => new AppError("onboarding_failed", "Could not create the organization. Try again.", 500),
};

/** Why this subdomain can't be used (slug_invalid / slug_taken), or null when it's free. */
export async function slugRefusal(slug: string) {
  const problem = validateOrgSlug(slug);
  if (problem) return onboardingRefusals.slugInvalid(problem);
  return (await db.organization.findUnique({ where: { slug }, select: { id: true } })) ? onboardingRefusals.slugTaken() : null;
}

/**
 * Creates a founder's org (specs/people.md rule 20). The token is spent in the same transaction that creates the org
 * and its admin, so one token makes one org even when sent twice at once; a refused request spends nothing. Then the
 * org's Chroma database, Meteroid customer and trial (the onboard-org workflow). When that fails, the half-made org is
 * removed and the token given back, only if every part of the undo worked; otherwise both stay for staff to look at.
 */
export async function foundOrg(input: { token: string; user: { id: string; email: string }; name: string; slug: string; websiteUrl: string | null }) {
  const refusal = await slugRefusal(input.slug);
  if (refusal) throw refusal;
  const org = await db
    .$transaction(async (tx) => {
      const invite = await tx.founderInvite.findUnique({ where: { token: input.token }, select: { email: true, acceptedAt: true } });
      if (!invite || invite.acceptedAt) throw onboardingRefusals.tokenInvalid();
      if (invite.email && invite.email.toLowerCase() !== input.user.email.toLowerCase()) throw onboardingRefusals.tokenEmailMismatch();
      const spent = await tx.founderInvite.updateMany({ where: { token: input.token, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (spent.count !== 1) throw onboardingRefusals.tokenInvalid();
      const now = new Date();
      return tx.organization.create({
        data: {
          id: randomUUID(),
          name: input.name,
          slug: input.slug,
          websiteUrl: input.websiteUrl,
          createdAt: now,
          members: { create: { id: randomUUID(), userId: input.user.id, role: "admin", createdAt: now } },
        },
        select: { id: true, slug: true },
      });
    })
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? onboardingRefusals.slugTaken() : error;
    });
  try {
    await runOnboarding(org.id);
  } catch (error) {
    console.error("Onboarding setup failed:", error);
    await undoFounding(org.id, input.token);
    throw onboardingRefusals.failed();
  }
  return org;
}

async function undoFounding(orgId: string, token: string) {
  try {
    await ChromaTenantService.deleteOrgDatabase(orgId);
    const billing = await db.orgBilling.findUnique({ where: { orgId }, select: { meteroidCustomerId: true } });
    if (billing) await unlinkOrgFromMeteroid(billing.meteroidCustomerId);
    await db.$transaction([
      db.organization.delete({ where: { id: orgId } }),
      db.founderInvite.update({ where: { token }, data: { acceptedAt: null } }),
    ]);
  } catch (error) {
    console.error(`Could not undo the half-made org ${orgId}; it and its spent setup link stay for staff:`, error);
  }
}
