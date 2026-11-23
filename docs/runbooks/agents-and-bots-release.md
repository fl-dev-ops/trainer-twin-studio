# Release runbook: agents (twins, role plays, bots) and the bot channel

Branch `feat/public-twin-voice` → `v2` (PR #25). Production: Vercel (web, chat, copilot from `v2`), LiveKit voice agent
(`lk agent deploy` from `agent/`), Neon project `bitter-forest-93765083`, branch `production`, database `neondb`.
Model and rules: [specs/agents.md](../../specs/agents.md). Widget and public calls: [public-twins-and-widgets.md](public-twins-and-widgets.md).

**Not ready to release.** Finish the open UI work at the end first, then follow these steps in order. Every step that
writes to production needs the owner's go-ahead at that moment.

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

## Open work before merge

- **UI:** finish the Bots pages (bot list and detail polish, persona and skills section design), the role play
  "Also played by" section and the twin Skills tab against real data with several personas and skills, and the twin
  library page (show topic skills inside the main twin).
- **Skills:** the bot's own SKILL.md (`bot` package format) and the twin's main coaching skill (authoring + publishing);
  supporting skills for role plays (the database still allows one role-play pin).
- **Cleanup after every org is merged:** remove the "every topic skill of the persona" fallback (`resolveTwinCatalog`).
- **Widget release gates** in [public-twins-and-widgets.md](public-twins-and-widgets.md) (visitor note delivery, Safari,
  real-browser audio).
