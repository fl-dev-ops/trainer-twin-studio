/**
 * The people rules that must always hold (specs/people.md, "Checks"). Read-only. Prints each check and exits 1 when
 * any fails. Run in rehearsals and after every release:
 *   bun scripts/check-org-people.ts              (DATABASE_URL from web/.env)
 *   DATABASE_URL=<prod> bun scripts/check-org-people.ts
 */
import { db } from "@/lib/db";

export const PEOPLE_CHECKS = [
  {
    rule: "no account has two member rows in one org",
    sql: `select count(*)::int as n from (select 1 from member group by "organizationId", "userId" having count(*) > 1) x`,
  },
  {
    rule: "every twin assignment's person is a member of its org",
    sql: `select count(*)::int as n from "TwinAssignment" t
          where not exists (select 1 from member m where m."organizationId" = t."orgId" and m."userId" = t."userId")`,
  },
  {
    rule: "every role-play assignment's member is in its org",
    sql: `select count(*)::int as n from "RolePlayAssignment" r
          where not exists (select 1 from member m where m.id = r."memberId" and m."organizationId" = r."orgId")`,
  },
  {
    rule: "admin and team hold no twin or role-play assignment",
    sql: `select (select count(*) from "TwinAssignment" t join member m on m."organizationId" = t."orgId" and m."userId" = t."userId"
                  where m.role in ('admin', 'team'))
               + (select count(*) from "RolePlayAssignment" r join member m on m.id = r."memberId" where m.role in ('admin', 'team'))
               as n`,
  },
  {
    rule: "every learner credits row belongs to a member of its org",
    sql: `select count(*)::int as n from "MinuteLedger" l
          where l.type in ('grant', 'usage', 'reclaim')
            and not exists (select 1 from member m join "user" u on u.id = m."userId"
                            where m."organizationId" = l."orgId" and lower(u.email) = lower(l.email))`,
  },
  {
    rule: "every org has exactly one admin",
    sql: `select count(*)::int as n from organization o
          where (select count(*) from member m where m."organizationId" = o.id and m.role = 'admin') <> 1`,
  },
  {
    rule: "no disabled member holds an active twin, a pending role play or a call in progress",
    sql: `select (select count(*) from "TwinAssignment" t join member m on m."organizationId" = t."orgId" and m."userId" = t."userId"
                  where m."disabledAt" is not null and t.status = 'active')
               + (select count(*) from "RolePlayAssignment" r join member m on m.id = r."memberId"
                  where m."disabledAt" is not null and r.status in ('pending', 'used'))
               + (select count(*) from "InterviewSession" s join member m on m."organizationId" = s."orgId" and m."userId" = s."userId"
                  where m."disabledAt" is not null and s.status in ('assigned', 'activating', 'active'))
               as n`,
  },
  {
    rule: "no pending invitations (people are added straight to their org)",
    sql: `select count(*)::int as n from invitation where status = 'pending'`,
  },
] as const;

/** Each check with how many rows break it (0 = holds). */
export async function checkOrgPeople() {
  const results = [];
  for (const check of PEOPLE_CHECKS) {
    const [row] = await db.$queryRawUnsafe<{ n: number }[]>(check.sql);
    results.push({ rule: check.rule, broken: row.n });
  }
  return results;
}

if (import.meta.main) {
  const results = await checkOrgPeople();
  for (const { rule, broken } of results) console.log(`${broken ? "FAIL" : "ok  "}  ${rule}${broken ? ` (${broken})` : ""}`);
  await db.$disconnect();
  process.exit(results.some((result) => result.broken) ? 1 : 0);
}
