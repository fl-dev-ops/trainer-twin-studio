# Prod DB migration: runbook (rehearsed on a dump)

Dump taken 2026-10-27 (read-only, direct endpoint): `/tmp/trainertwin-prod-20261027-2105.dump` (7.5 MB, PG 18.6).
Local copies:
- `trainertwin_prod`: the restored dump, untouched;
- `trainertwin_prod_rehearsal`: the dump with every step below applied.

## What prod has

- 2 orgs:
  - careerwithvasanth: 6 members; 10 interview agents; 1 persona;
  - latencytest: 1 member; 5 agents; 5 personas.
- 186 sessions, 76 knowledge docs, 19 voices, 36 role-play assignments.
- 38 migrations applied; 10 pending:
  - `add_learner_reports_session_evaluation`, `add_copilot_session_metadata`, `add_usage_metering`;
  - the 7 twin / role-play migrations.

## Problems the rehearsal found

| # | Problem | Fix |
|---|---|---|
| 1 | `20260927182041_add_learner_reports_session_evaluation` fails: its 3 `InterviewSession` columns already exist (drift, probably from `db push`); only its `Deployment.updatedAt DROP DEFAULT` is missing | Run that one statement, then `migrate resolve --applied` |
| 2 | FK `InterviewSession_assignmentId_fkey` missing (from the half-failed `unified_session_runtime`): 3 sessions point to deleted assignments | NULL the 3 orphan links (what `ON DELETE SET NULL` would have done), add the FK |
| 3 | careerwithvasanth has `owner` (victorywithvasanth@gmail.com) **and** `ADMIN` (diag-admin2@acme.com); both become `admin`, which breaks one admin per org | **Decision needed.** Proposal: Vasanth stays admin; diag-admin2 (a test account) becomes `team` |

Apart from these, the 9 remaining migrations apply cleanly. After the fixes:
- the schema matches a fresh migration chain (only column order differs);
- all 6 `tests/sql` suites pass;
- all 15 agents are `ROLEPLAY`;
- assigned learners become `user` members.

## Steps (prod)

```bash
export DATABASE_URL='<direct, non-pooler URL>'   # never the -pooler host for migrations
```

0. **Backup:** a Neon branch (or `pg_dump -Fc`) right before. Use maintenance timing: deploy web right after.
1. Fix #1:
   ```sql
   ALTER TABLE "Deployment" ALTER COLUMN "updatedAt" DROP DEFAULT;
   ```
   ```bash
   bunx prisma migrate resolve --applied 20260927182041_add_learner_reports_session_evaluation
   ```
2. Fix #2:
   ```sql
   UPDATE "InterviewSession" s SET "assignmentId" = NULL
    WHERE "assignmentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "RolePlayAssignment" r WHERE r.id = s."assignmentId");
   ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_assignmentId_fkey"
     FOREIGN KEY ("assignmentId") REFERENCES "RolePlayAssignment"(id) ON UPDATE CASCADE ON DELETE SET NULL;
   ```
3. `bunx prisma migrate deploy`. At the dump that meant 9 migrations; with later work it is 12, including `avatar_original_image` and `drop_domains_1/2` (plans/drop-domains.md). All were rehearsed on the dump.
4. Fix #3 (after the decision): `UPDATE member SET role = 'team' WHERE id = <diag-admin2's member id>;`
5. Verify:
   - `migrate status` is clean;
   - the `tests/sql/*.sql` suites (each rolls back) pass;
   - one admin per org.
6. Deploy web, then chat, then copilot (with `SCENARIO_INGEST_SECRET` and `STUDIO_URL`), then the voice agent.
