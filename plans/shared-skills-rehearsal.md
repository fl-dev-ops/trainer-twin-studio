# Shared skills — migration rehearsal (local)

Date: 20 November 2026. All work on local copies; the source databases were only read.

## Production copy

Source: `trainertwin_prod_rehearsal` (production snapshot, 26 Oct 2026: 2 orgs, 15 role plays, 186 sessions, no skill
packages). Copies: `trainertwin_prod_skills_rehearsal_local`, `trainertwin_prod_skills_stage_local`.

1. **Migration chain (27 pending migrations).** Stopped at `20261114120000_one_admin_per_org`: careerwithvasanth has two
   admins in this snapshot. This is runbook fix #3 in `plans/prod-migration.md` (Vasanth stays admin, the test account
   `diag-admin2` becomes team); the migration notes production had one admin per org by 11 Nov. After replaying that
   fix, `migrate resolve --rolled-back` and `migrate deploy` applied the rest cleanly (seconds).
   **Release step:** confirm one admin per org in production before deploying.
2. **Data fingerprints** (`web/scripts/rehearsal-fingerprint.ts`: row count + md5 per table over the original columns,
   read-only). Staged: v3 migrations first, then the 10 shared-skills/voice migrations.
   - Shared-skills + shared-voices migrations: **52/52 existing tables unchanged**.
   - v3 migrations changed three tables, all intended by `20261111120000_people_first`: duplicate members merged
     (13 → 12), role-play assignments merged / admin-team learner assignments removed (36 → 13), and 10 sessions of
     those removed assignments lost only their assignment link (history kept, as the migration documents);
     `recipientEmail` columns dropped.
3. **Skill migration** per org: dry-run, apply, check, apply again — complete, 0 entries (no packages yet), 0 gaps,
   identical inventory hash; cutover report keeps both orgs in compatibility mode.
4. **Vasanth port** on the migrated copy: 10 packages, additive only, verified (see `vasanth-skill-port.md`).
5. **App on the migrated copy**: real conversations 10/10 ported and 10/10 original interviews.

## Packages without their original files

On a copy of the local dev DB with Olga's 11 packages (artifacts under production S3 prefixes, not available locally):
dry-run and apply both report all 20 references as actionable failures ("missing or cross-organization artifact
prefix"), write **no** registry rows, and cutover is refused ("requires complete verified current and historical
coverage"). A full package rehearsal needs read access to the original package files (or a verified mirror).

## Still required for a production run

- Read-only access to the production package files for a full-package rehearsal on a fresh production copy.
- One-admin check in production; Chroma Cloud database quota (currently at its 10-database limit).
- Explicit approval for the production migration and any ownership cutover.
