# Vasanth interviews → skills (Phase 2 port)

Status: implemented and verified locally, 20 November 2026. Not deployed; no production writes.

## Decision

Each of Vasanth's ten no-skill interview role plays is ported into an **authored skill package** and published as a
**new** role play next to the original (`<org>-<original slug>`, name suffixed "(skill)"). The originals, their
history, assignments and sessions are untouched and keep the legacy interview mode. Converting in place was rejected:
giving an existing agent a skill switches chat from interview mode to skill mode and would change live behavior.

## What the port carries

`web/lib/interview-skill.ts` renders SKILL.md + scenario.json + items.json from the stored agent:

- verbatim: instruction, principles, opening, stage goals/openings, evidence keys and definitions (★ completion keys),
  allowed moves, answer classifications, evidence statuses, knowledge query guidance;
- the interview plan: type, main-question quotas or question mix, topics, follow-ups per question, session turn cap;
- rendering rules (≤45 words, one focal ask, ≤1 question mark) and a consistent close;
- settings beside the package: résumé upload (`before.preUpload`), workspace tools from the question mix
  (code editor, choice, canvas, PDF preview), voice and intro video, `portedFrom` provenance.

Format: `authored-roleplay` (trainer_role Interviewer, learner_role Candidate). Items are empty (no invented examples).

## Known differences from the originals (reported per agent by the port)

- Skill sessions run the authored procedure: the legacy interview planner, typed question bank and résumé-claim
  highlighting tools are not used. The model reads the résumé with `read_document`.
- The résumé upload is offered but no longer enforced as required (skill role plays have no required-upload switch).
- The upload prompt's "deleted after this session" sentence is removed pending a retention review.
- Full mock: all five stages are listed in order; question quotas are session-wide.
- Scale has no topics selected; the interviewer chooses from the stage goals.
- Reports: no `after` settings, so the existing session report applies (unchanged).

## Commands (local only; refuses non-local DB, S3 or Chroma)

```sh
bun scripts/port-vasanth-skills.ts --org careerwithvasanth            # dry run: plan + differences
bun scripts/port-vasanth-skills.ts --org careerwithvasanth --apply    # publish; rerun is a no-op
bun scripts/interview-skill-chat-check.ts --org careerwithvasanth --turns 3 --apply            # real model turns
bun scripts/interview-skill-chat-check.ts --org careerwithvasanth --turns 1 --originals --apply # originals still run
```

## Verification

| Check | Result |
| --- | --- |
| Local copy of the dev DB (`trainertwin_vasanth_local`), local S3 + Chroma | 10 published, all v1 ready/indexed; rerun 10 no-ops; 10 originals byte-identical to source |
| Migrated production copy (`trainertwin_prod_skills_stage_local`) | 10 published; only new rows; 15 original agents byte-identical; `migrate-skills --check` 10 verified, 0 gaps; `check-skills` 0 failures |
| Real conversations, ported (local chat + real model) | 10/10 on each copy; interviewer asks one focused question per turn within the word limit; pin unchanged across a republish |
| Real conversations, originals after migration | 10/10, still unpinned legacy interview sessions |
| Unit / DB / chat tests | `interview-skill.test.ts` 5, `interview-skill-port.db.test.ts` 2, chat `roleplay.test.ts` +2 |

Next decision for the owner: whether learners should see the ported versions (and retire the originals later).
