-- specs/people.md rule 7 and Checks: every org has at most one admin, whatever writes the member row.
-- Fails (and changes nothing) if an org has two admins today; prod had one each on 11 Nov 2026.
CREATE UNIQUE INDEX "member_one_admin_per_org" ON "member" ("organizationId") WHERE "role" = 'admin';
