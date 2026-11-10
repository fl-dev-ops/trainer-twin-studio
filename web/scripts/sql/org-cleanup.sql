-- One org's clean-up (psql -v org=<slug> -v keep_emails="'a@x','b@y'" -v keep_sessions="'id1','id2'"):
-- keeps the listed members (their member rows with the highest role) and sessions; removes every other member,
-- session, and their minutes, assignments and pending invitations. Order matters: sessions before the twin
-- assignments they belong to (DB rule), assignments before members.
create temp table org on commit drop as select id from organization where slug = :'org';
create temp table keep_emails on commit drop as select lower(e) as email from unnest(array[:keep_emails]::text[]) e;
create temp table gone_sessions on commit drop as select s.id from "InterviewSession" s where s."orgId" = (select id from org) and s.id <> all(array[:keep_sessions]::text[]);
-- members to remove: anyone not kept, plus extra rows of a kept person (keep one row each: admin before team before user)
create temp table gone_members on commit drop as
  select m.id, lower(u.email) as email from member m join "user" u on u.id = m."userId"
  where m."organizationId" = (select id from org)
    and (lower(u.email) not in (select email from keep_emails)
      or m.id <> (select m2.id from member m2 where m2."organizationId" = m."organizationId" and m2."userId" = m."userId"
                  order by case m2.role when 'admin' then 0 when 'team' then 1 else 2 end, m2."createdAt" limit 1));
create temp table gone_emails on commit drop as select distinct email from gone_members where email not in (select email from keep_emails);
select :'org' || ': removing ' || (select count(*) from gone_members) || ' member rows, ' || (select count(*) from gone_sessions) || ' sessions';
delete from "MinuteLedger" where "orgId" = (select id from org) and (lower(email) in (select email from gone_emails) or "sessionId" in (select id from gone_sessions));
delete from "UsageEvent" where "sessionId" in (select id from gone_sessions);
delete from "InterviewSession" where id in (select id from gone_sessions);
delete from "TwinAssignment" where "orgId" = (select id from org) and lower("recipientEmail") in (select email from gone_emails);
delete from "RolePlayAssignment" where "orgId" = (select id from org) and lower("recipientEmail") in (select email from gone_emails);
delete from invitation where "organizationId" = (select id from org) and lower(email) not in (select email from keep_emails);
delete from member where id in (select id from gone_members);
