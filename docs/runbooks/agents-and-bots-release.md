# Release runbook: agents (twins, role plays, bots) and the bot channel

Branch `feat/public-twin-voice` → `v2` (PR #25). Production: Vercel (web, chat, copilot from `v2`), LiveKit voice agent
(`lk agent deploy` from `agent/`), Neon project `bitter-forest-93765083`, branch `production`, database `neondb`.
Model and rules: [specs/agents.md](../../specs/agents.md). Widget and public calls: [public-twins-and-widgets.md](public-twins-and-widgets.md).

## Release record: 2026-11-23

Released: PR #25 merged into `v2` as `695646b1`. Every production write was preceded by a Neon backup branch.

| Step | Result |
|---|---|
| Backup before merge | `pre-agents-release-2026-11-23` (`br-icy-bread-azg431u6`) |
| Rehearsal | All 9 migrations on a fresh branch of production: 45/45 agents backfilled, 0 mismatched; branch deleted |
| Deploy | Web, chat, copilot Ready on Vercel; the web build applied the 9 migrations; `dash.` and `olga.trainertwin.com` health 200 |
| Voice agent | `lk agent deploy`: version `6kgZRPyaVsPj` running (was `RofWANs8mH6T`) |
| Backup before data | `pre-agents-data-2026-11-23` (`br-jolly-frost-azqto2iz`) |
| Bots flag | Demo org (`latencytest`) metadata `{"bots": true}`; every other org has no bots |
| Olga skills | Imported (objection handling v1–v5, 70 items; client goes silent v1–v6, 77 items) and merged into `olga-olga-twin` as active supporting skills; topic twins live; 57 sessions and 14 assignments unchanged |
| Backup before role plays | `pre-pooled-roleplays-2026-11-23` (`br-polished-cake-azkkloj8`) |
| Demo role plays | 18 Olga-spec role plays (9 personas × 2 scenarios) replaced by 2 pooled role plays with all 9 personas each; the 18 archived (no sessions or assignments) |

Notes from the release:
- **Previews:** every `trainer-twin-studio` preview fails (no `DATABASE_URL` in previews, so `env.ts` rejects the build).
  This predates the release; the gate is a local production build (`NEXT_DIST_DIR=.next-buildcheck bunx next build`).
- **Widget bundles:** the web build ships the committed `web/public/widgets/*` (the widgets tests check they match a
  fresh build). Vercel's bun can't read the widgets lockfile, so `build` no longer runs `build:widgets`; `dev` still does.
- **Backfill noise:** `backfill-skill-sources` logs "Published artifacts must belong to the organization" for Demo org
  role plays stored under the legacy `trainertwin/kb` prefix. Non-fatal; those packages can't be imported into the
  skill library until re-published.
- **Skill import prefix:** run `scripts/migrate-skills.ts` with `S3_BASE_PREFIX=prod/trainertwin/kb` (local
  `.env.prod` has the dev prefix). Each import writes the org's Chroma items under new skill version ids.
- Delete the backup branches once the release has settled.

## What changes in production

| Area | Change |
|---|---|
| Database | 9 migrations (below): `BOT` kind, public `Deployment` fields, `AgentSkill`, `AgentPersona`, pin and persona triggers |
| Twins | A twin's skills in a call = its active supporting skills (once its org is merged); unmerged twins keep "every topic skill of the persona" |
| Role plays | Optional extra personas; each session plays one active persona at random |
| Bots | New module under `/bots`: own persona, purpose, supporting skills, public calls, website widget |
| Learner page | No anonymous calls on `/t/` (assigned learners only, as on `v2`) |
| Copilot | New tools: `bot_*`, `twin_skills_set`, `roleplay_personas_set` |

Migrations, applied in this order by the web build (`prisma migrate deploy`):

1. `20261118150000_public_twin_voice`, `20261118151000_public_twin_org_usage`, `20261118160000_widget_session_origin`
2. `20261123170000_bot_kind` (adds the `BOT` enum value; must commit before the next one)
3. `20261123170100_bot_split`, `20261123190000_bot_module`
4. `20261123200000_agent_personas_supporting_skills` (backfills one `AgentPersona` row per agent)
5. `20261123210000_unified_pins`, `20261123220000_persona_pool_swap`

All were rehearsed on a Neon branch copy of production (`dryrun-unified-skills-2026-11-23`): 45 of 45 agents backfilled,
no twin or role play changed, rules verified.

## 1. Preflight

1. **Backup:** create a Neon branch from `production`, named `pre-agents-release-<date>`. Note its id.
2. **Env:** in `web/.env.prod` and Vercel, `S3_BASE_PREFIX=prod/trainertwin/kb` (the local `.env.prod` had
   `trainertwin-dev/kb`, which makes every skill import fail with "cross-organization artifact prefix").
3. **Rehearse** on a fresh Neon branch of production: `DATABASE_URL=<branch> bunx prisma migrate deploy`, then the
   checks in step 4 against it. Delete the branch afterwards.
4. **Tests on the release commit:** web unit, DB, flows and e2e; chat; copilot; widgets; voice agent.

## 2. Deploy

1. Merge PR #25 into `v2`. Vercel builds web (migrations run in its build), chat and copilot.
2. Voice agent: `lk agent deploy` from `agent/` only if `agent/` changed in the release.
3. Watch the web build log for the migrations, then the first requests on `/twin`, `/roleplay` and `/bots`.

## 3. Per org: skills into the library, then the twin merge

Only orgs whose twins should draw on chosen skills. Until an org is merged, its twins behave exactly as before.

```bash
cd web
# a) Inventory, read-only. Twin skills should be "unmapped" (importable); old role-play packages may fail.
set -a; . ./.env.prod; set +a
DATABASE_URL=<production> DATABASE_URL_UNPOOLED=<production> bun scripts/migrate-skills.ts --org <slug> --dry-run --production
# b) Import (writes skill versions to Postgres and their items to the org's Chroma database).
DATABASE_URL=<production> DATABASE_URL_UNPOOLED=<production> bun scripts/migrate-skills.ts --org <slug> --apply --production
```

c) Merge: attach each live topic twin's skill to the persona's main twin, active, in creation order. Topic twins stay
**live** (they hold each skill's version history; the copilot updates skills through them).

```sql
BEGIN;
INSERT INTO "AgentSkill" ("agentId", "skillId", "orgId", position, active)
SELECT main.id, topic."primarySkillId", main."orgId", row_number() OVER (ORDER BY topic."createdAt"), true
FROM "Agent" main
JOIN "Agent" topic ON topic."personaId" = main."personaId" AND topic."orgId" = main."orgId"
  AND topic.kind = 'TWIN' AND topic.id <> main.id AND topic."archivedAt" IS NULL AND topic."primarySkillId" IS NOT NULL
WHERE main.slug = '<main twin slug>' AND main.data->>'source' = 'twin'
ON CONFLICT DO NOTHING;
COMMIT;
```

Only merge when every live topic twin of the persona has a `primarySkillId` (imported); otherwise a topic would drop
out of the twin's calls. Olga (`olga`, main twin `olga-olga-twin`): 2 topic skills (objection handling, 70 items; client
goes silent, 77 items); 9 older role-play packages fail import under a legacy prefix and are not needed for the twin.

## 3b. Turn bots on for an org

Bots exist only in orgs whose metadata has `"bots": true`; elsewhere the Bots menu is hidden, the bots API and copilot
bot tools answer not found, and widgets find no bot. Merge the flag into the existing metadata, never overwrite it:

```sql
UPDATE organization SET metadata = (coalesce(nullif(metadata, ''), '{}')::jsonb || '{"bots": true}'::jsonb)::text
WHERE slug = '<org slug>' RETURNING slug, metadata;
```

## 3c. Role plays with a persona pool (from files)

A role play file in `web/data/roleplays/<set>/` may list `personas` (slugs, the builder's persona first); seeding sets
the pool so each session plays one of them at random. Olga's spec: `node scripts/gen-olga-spec-roleplays.mjs
data/roleplays/olga-spec` writes the 18 single-persona files and `olga-spec-pooled` (2 role plays, 9 personas each).

```bash
set -a; . ./.env.prod; set +a
S3_BASE_PREFIX=prod/trainertwin/kb DATABASE_URL=<production> DATABASE_URL_UNPOOLED=<production> \
  bun scripts/seed-roleplays.ts --org <org slug> --set olga-spec-pooled --dry-run   # then without --dry-run
```

Archive replaced role plays only when they have no sessions or assignments, in one transaction that checks the count.

## 4. Verify

```sql
-- Every agent has its persona row; none mismatched (expect 0).
SELECT count(*) FROM "Agent" a WHERE NOT EXISTS (
  SELECT 1 FROM "AgentPersona" p WHERE p."agentId" = a.id AND p."personaId" = a."personaId");
-- A merged twin's skills, in order.
SELECT s."ownerSlug", ag.position, ag.active FROM "AgentSkill" ag JOIN "Skill" s ON s.id = ag."skillId"
JOIN "Agent" a ON a.id = ag."agentId" WHERE a.slug = '<main twin slug>' ORDER BY ag.position;
```

In the app: the twin's **Skills** tab lists the skills; a learner call on the twin works; a role play with one persona
behaves as before; `/bots` opens and a new bot can be created with public calls off.

## 5. Rollback

- **Code:** revert the merge on `v2` and redeploy. The added columns and tables are unused by `v2` code and can stay.
- **Data:** restore from the `pre-agents-release-<date>` Neon branch (Neon restore), or undo a merge alone:
  `DELETE FROM "AgentSkill" WHERE "agentId" = (SELECT id FROM "Agent" WHERE slug = '<main twin slug>');` (the twin
  returns to every topic skill of its persona).
- Chroma items written by the import are keyed by new skill version ids; they are unused after a rollback.

## Open work

- **UI:** check the role play "Also played by" section and the twin Skills tab against real data (several personas and
  skills), and show topic skills inside the main twin on the twin library page.
- **Live checks:** a learner call on Olga's twin (both skills in use) and a few runs of the Demo pooled role plays.
- **Merge the other orgs' twins** once their skills are imported (step 3).
- **Skills:** the bot's own SKILL.md (`bot` package format) and the twin's main coaching skill (authoring + publishing);
  supporting skills for role plays (the database still allows one role-play pin).
- **Cleanup after every org is merged:** remove the "every topic skill of the persona" fallback (`resolveTwinCatalog`).
- **Widget release gates** in [public-twins-and-widgets.md](public-twins-and-widgets.md) (visitor note delivery, Safari,
  real-browser audio).
