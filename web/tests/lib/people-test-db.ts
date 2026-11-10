import { db } from "@/lib/db";

/**
 * specs/people.md "Checks", for one org (the global ones in scripts/check-org-people.ts would see other test files'
 * rows while they run in parallel). Each count must be 0; tests end flows with `expect(await peopleRulesBroken(id))`.
 */
export async function peopleRulesBroken(orgId: string) {
  const count = async (sql: string) => (await db.$queryRawUnsafe<{ n: number }[]>(sql, orgId))[0].n;
  return {
    duplicateMembers: await count(`select count(*)::int as n from (select 1 from member where "organizationId" = $1 group by "userId" having count(*) > 1) x`),
    memberWithoutAccount: await count(`select count(*)::int as n from member m where m."organizationId" = $1 and not exists (select 1 from "user" u where u.id = m."userId")`),
    twinAssignmentWithoutMember: await count(`select count(*)::int as n from "TwinAssignment" t where t."orgId" = $1
      and not exists (select 1 from member m where m."organizationId" = t."orgId" and m."userId" = t."userId")`),
    rolePlayAssignmentWithoutMember: await count(`select count(*)::int as n from "RolePlayAssignment" r where r."orgId" = $1
      and not exists (select 1 from member m where m.id = r."memberId" and m."organizationId" = r."orgId")`),
    studioAssignments: await count(`select ((select count(*) from "TwinAssignment" t join member m on m."organizationId" = t."orgId" and m."userId" = t."userId"
      where t."orgId" = $1 and m.role in ('admin', 'team')) + (select count(*) from "RolePlayAssignment" r join member m on m.id = r."memberId"
      where r."orgId" = $1 and m.role in ('admin', 'team')))::int as n`),
    creditsWithoutMember: await count(`select count(*)::int as n from "MinuteLedger" l where l."orgId" = $1 and l.type in ('grant', 'usage', 'reclaim')
      and not exists (select 1 from member m join "user" u on u.id = m."userId" where m."organizationId" = l."orgId" and lower(u.email) = lower(l.email))`),
    pendingInvitations: await count(`select count(*)::int as n from invitation where "organizationId" = $1 and status = 'pending'`),
  };
}

export const NOTHING_BROKEN = {
  duplicateMembers: 0, memberWithoutAccount: 0, twinAssignmentWithoutMember: 0, rolePlayAssignmentWithoutMember: 0, studioAssignments: 0, creditsWithoutMember: 0, pendingInvitations: 0,
};

/** Accounts a test's actions created (addPeopleToOrg makes them): every test email contains the fixture's org id. */
export const removeAccountsOf = (orgId: string) => db.user.deleteMany({ where: { email: { contains: orgId } } });
