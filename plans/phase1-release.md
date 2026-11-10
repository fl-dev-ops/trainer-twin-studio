# Phase 1 release runbook (org credits from Meteroid)

Rehearsed end to end on 10 Nov 2026 on a copy of prod with Meteroid's **Sandbox** tenant. Run the steps in order;
each is safe to repeat. Secrets: `~/.config/meteroid/keys.env` (Meteroid prod/sandbox keys and webhook secrets).
Prod DB URLs: `neon connection-string production --project-id bitter-forest-93765083 --org-id org-bitter-lake-26948244`
(add `--pooled false` / use the unpooled URL for migrations).

## Already done (10 Nov)
- Meteroid: Production tenant key `trainertwin-web-prod`, `scripts/meteroid-setup.ts` run (MINS, voice_minutes,
  plan "Credits"), USD added to the tenant's currencies, webhook → `https://dash.trainertwin.com/api/meteroid/webhook`.
- Meteroid Postgres backups every 6 h to `s3://foreverlearning-meteroid-backups` (90 days); a restore was tested.
- Vercel `trainer-twin-studio` production env: `METEROID_API_URL`, `METEROID_API_KEY`, `METEROID_WEBHOOK_SECRET`,
  `VERCEL_FORCE_NO_BUILD_CACHE=1` (a stale build cache broke the workflow package's install; remove after one clean build).

## Release
1. **Backups, right before:** Neon branch `pre-phase1-<date>` from `production`, and
   `pg_dump -Fc --no-owner --no-privileges -d "$PROD" -f ~/Backups/trainertwin/prod-pre-phase1-<date>.dump`.
2. **Remove test data** (`web/scripts/sql/org-cleanup.sql`, one transaction per org):
   ```sh
   psql "$PROD" -v ON_ERROR_STOP=1 -v org=olga -v keep_emails="'liveitupdxb20@gmail.com','cathy@foreverlearning.in','team@foreverlearning.in'" \
     -v keep_sessions="'cmvza3hzf000008jtxot04aef','cmvzazalm002f07l2itnh4yeb','cmw7t5gn8000007l5cxn3ruuu','cmw7tjbcx001907l5y8p8ny2l'" \
     -c begin -f web/scripts/sql/org-cleanup.sql -c commit
   psql "$PROD" -v ON_ERROR_STOP=1 -v org=careerwithvasanth -v keep_emails="'victorywithvasanth@gmail.com'" -v keep_sessions="'none'" -c begin -f web/scripts/sql/org-cleanup.sql -c commit
   psql "$PROD" -v ON_ERROR_STOP=1 -v org=latencytest -v keep_emails="'admin@demo.com'" -v keep_sessions="'none'" -c begin -f web/scripts/sql/org-cleanup.sql -c commit
   ```
   Expected (rehearsal): olga keeps Olga + cathy@ + team@ and her 4 calibrations (61 min); careerwithvasanth keeps
   Vasanth (admin) and no sessions; latencytest keeps admin@demo.com and no sessions.
3. **Migrate** (additive; the current prod code keeps working): `cd web && DATABASE_URL="$PROD_UNPOOLED" bunx prisma migrate deploy`.
4. **Link the orgs to Meteroid prod** (`cd web`, `DATABASE_URL="$PROD"`, `METEROID_API_KEY=$METEROID_PROD_API_KEY`):
   ```sh
   bun scripts/meteroid-link-org.ts --org olga --minutes 90 --expires 2027-11-<dd> --reason "Starting credits" --grant-key starting-olga-phase1 --production
   bun scripts/meteroid-link-org.ts --org careerwithvasanth --trial <release date> --production
   bun scripts/meteroid-link-org.ts --org latencytest --trial <release date> --production
   ```
5. **Charge olga's 4 calibrations** (61 min → olga ≈ 29 left):
   `bun scripts/charge-past-sessions.ts --org olga --sessions cmvza3hzf000008jtxot04aef,cmvzazalm002f07l2itnh4yeb,cmw7t5gn8000007l5cxn3ruuu,cmw7tjbcx001907l5y8p8ny2l --production`
6. **Merge PR #15** → Vercel builds web (its `prisma migrate deploy` has nothing left to do); chat and copilot rebuild
   unchanged; Dokploy deploys the voice agent (VoxCPM2, LiveKit agents 1.8.11).
7. **Check:** `/api/health`; Credits page per org (29 / 30 / 30); a team call starts and ends ("Time's up" path not
   needed); a Meteroid webhook delivery shows 200 (Meteroid › Production › Webhooks); session-start time on Vercel's
   workflow queue (if slow, Vercel instant rollback).

## Rollback
Vercel instant rollback to the previous production deployment. The migration only adds tables/columns, so the old code
runs on the new schema. Data: Neon branch from step 1.
