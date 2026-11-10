import { db } from "@/lib/db";
import { orgName } from "@/lib/invite/person-email";
import { studioUrl } from "@/lib/invite/links";
import type { CreditGrant } from "@/lib/meteroid";
import { ADMIN, orgPeople } from "@/lib/org-people";
import { sendEmailNow } from "@/lib/send-email-now";

/**
 * "Credits added" for the org (specs/people.md rule 11): after a sync, each new grant (Meteroid: free minutes, a pack
 * bought) emails the org's admin once. Grants already announced are kept in OrgBilling.announcedGrantIds; the email's
 * key is the grant, so a retry can't send it twice.
 */
export async function announceNewGrants(orgId: string) {
  const billing = await db.orgBilling.findUnique({ where: { orgId }, select: { grants: true, balanceMinutes: true, announcedGrantIds: true } });
  if (!billing) return { announced: 0 };
  const told = new Set(billing.announcedGrantIds);
  const fresh = (billing.grants as CreditGrant[]).filter((grant) => !told.has(grant.id) && grant.minutes > 0);
  if (!fresh.length) return { announced: 0 };
  const [admin] = await orgPeople(orgId, { roles: [ADMIN] });
  if (admin) {
    const name = await orgName(orgId);
    for (const grant of fresh) {
      const result = await sendEmailNow({
        kind: "orgCredits",
        args: {
          to: admin.email,
          orgName: name,
          added: grant.minutes,
          balance: Math.max(0, billing.balanceMinutes),
          expires: grant.expiresAt
            ? new Date(grant.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
            : null,
          reason: grant.reason,
          creditsUrl: `${studioUrl()}credits`,
        },
      }, `org-credits:${grant.id}`);
      if (!result.success && result.error !== "RESEND_API_KEY is not set") throw new Error(`Org credits email to ${admin.email}: ${result.error}`);
    }
  }
  await db.orgBilling.update({ where: { orgId }, data: { announcedGrantIds: { push: fresh.map((grant) => grant.id) } } });
  return { announced: fresh.length };
}
