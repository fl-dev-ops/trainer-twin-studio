# Shared skills Phase 1 — release checklist

Status: local implementation checkpoint only. No production migration, canary, backfill or deployment has been approved.
Read [the durable execution ledger](shared-skills.md#execution-ledger--resume-here) and [the rules](../specs/skills.md).

## Scope

- Add Skill/SkillVersion and nullable Agent.primarySkillId.
- Route existing builder, authored-role-play and twin publication through managed package reservation/activation.
- Existing editors, Agent snapshots, voice prompts and public APIs stay on their compatibility contracts.
- New managed examples have BOTH a skillVersionId and a skillIndexScope; the scope is the committed artifacts prefix.
- Failed/expired physical uploads leave isolated orphan attempts, not a partially activated package.
- No eager historical backfill, SessionSkill pins, exact-runtime retrieval cutover or package-data deletion.

## Local verification

From `web/`, use ONLY the isolated local test database:

```sh
export DATABASE_URL='postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp'
export DATABASE_URL_UNPOOLED="$DATABASE_URL"
bun install --frozen-lockfile
bunx prisma generate
bunx prisma migrate deploy
bun test --parallel .db.test
bun test --parallel tests/flows
bun test --parallel tests/lib/shared-skill-files.test.ts tests/lib/scenario-item-versions.test.ts tests/lib/scenario-ingest.test.ts tests/lib/scenario-ingest-contract.test.ts tests/api/skills.test.ts
bunx tsc --noEmit
```

The cross-service contract test imports copilot/chat code: install their frozen dependencies too.
Existing broad unit tests also include live-provider/seed-dependent suites despite their `.test.ts` names. Do not
mislabel a broad-unit pass as an offline/unit-only result or use production credentials to make it pass.

For a local production build, set a disposable local BETTER_AUTH_SECRET and localhost BETTER_AUTH_URL. Do not run
`scripts/vercel-build.sh` against production as a casual build check: it also runs migrations and existing backfills.
Next 16.4.3 emitted a security advisory during verification. Review/upgrade separately before a production release;
retrying the build does not resolve that advisory.

## Before a release is approved

1. Confirm the intended PR base/release destination. Current work is on `feat/shared-skills` from `v3`.
2. Use an isolated staging DB and isolated S3 prefix/Chroma resources; never share production indexes for rehearsal.
3. Record current web/chat/copilot/agent releases and take a fresh DB backup/recovery point.
4. Rehearse migrations in order:
   - `20261119120000_shared_skills`
   - `20261119121000_skill_publication_intent`
5. Compare before/after existing Agent, persona, session, assignment, member and credit counts. These migrations should
   add registry structures only; no historical skill rows should appear merely from migrating.
6. Check S3/Chroma/model configuration, internal ingestion auth and web's existing copilot/voice service credentials.
7. Run the staging canary below with real providers. Capture results without secrets or learner content.
8. Review the bounded transaction limitation: provider writes retain the existing 120-second save transaction until
   managed runtime adoption. Timeout-safe managed namespaces do not remove legacy retrieval/fallback limitations.
9. No merge/deploy/production-data operation until explicit approval.

## Staging canary

- [ ] Create a builder role play, authored role play and current-format twin skill through their actual authoring paths.
- [ ] Inspect `GET /api/skills/<agent-slug>` as studio admin/team: ready version, format, hash, prefix and item count.
- [ ] Signed-out/learner/disabled/other-org access refuses; response is `no-store` and excludes package content.
- [ ] Run `bun scripts/check-skills.ts --org <staging-slug>` against the staging configuration. Remote inspection requires
  the explicit `--production` argument even for a remote staging DB; it is read-only, not a backfill command.
- [ ] Republish unchanged content: same package ID/version, no provider rewrites.
- [ ] Change examples or instructions: new package version; original files stay unchanged.
- [ ] Change only scoring or persona: experience behavior changes without a new content package.
- [ ] Run real multi-turn builder/authored/twin voice calls; check examples, source links, enabled workspaces, endings,
  transcripts, recordings and reports/calibration as applicable.
- [ ] Force upload/index failure safely in staging; old published experience remains usable, failed state is visible,
  and retry preserves package identity while using a fresh physical attempt prefix.
- [ ] Verify interrupted publication, concurrent edits and settings saves; stale requests refuse/retry rather than
  overwrite newer saved state. A late timed-out callback cannot mutate the winning managed namespace.
- [ ] Verify existing unedited historical skills, archived/history reads and no-skill interviews still work.
- [ ] Record publish, activation/context and retrieval timings before/after; do not infer production performance from mocks.

## Approved rollout and rollback

1. Drain active publishers and calls before changing releases. Apply additive schema before the new writer.
2. Deploy the reviewed web checkpoint; no chat/copilot/agent behavior change is required by Phase 1.
3. Enable a funded internal canary first, inspect registry/failed attempts and verify actual voice/provider behavior.
4. Roll out only after canary passes. No bulk historical backfill in this phase.
5. If publication/voice fails, stop publication and drain calls. Roll back to the recorded compatible release, leaving
   additive tables in place. Check for late provider callbacks/pending attempts before accepting publications again.
6. Preserve history and all ready files. Do not delete orphan attempts, drop tables or clear credits as incident repair.
7. Record approved release SHA, migration results, canary evidence and rollback target in `shared-skills.md`.
