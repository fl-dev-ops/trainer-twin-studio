# Role play — what must not break

**Status:** checklist, 2026-10-27. Read before any role-play change; tick each line when a change is verified.

---

## A. What the twin / roles work already changed on the role-play side

Commits `3ab3e7b`, `7a1784e`, `4a892ac`, `3a36916`. Nothing role-play was deleted (the only deleted file is the
twin calibration mock `/dash/calibration/[id]`). These are behaviour changes:

| # | Change | Verdict |
|---|---|---|
| A1 | `/api/v1/users` returned `role: "user"`; the published contract (`docs/openapi.yaml` `User.role: const member`) says `member` | ✅ **Fixed** in the commit after `3a36916`: the API answers `member` (`API_LEARNER_ROLE`), the DB keeps `user`; test `v1-users-contract` |
| A2 | `/api/v1/sessions` could start a twin (default mode `chat`) | ✅ **Decided: the public API is role play only.** A twin scenario or deployment key answers exactly like an unknown one (400 `Agent not found` / `Agent is required`); twin sessions are not listed, returned or deletable (404). Test `v1-roleplay-only` |
| A3 | `/api/v1/scenarios` listed twins | ✅ **Fixed:** role plays only; a twin slug answers 404 like an unknown scenario. Docs say so (`docs/guides/scenarios.mdx`, `openapi.yaml`) |
| A4 | `/agents`, `/sessions`, `/learners` show role plays only; twins moved to `/twin/*` | ✅ intended |
| A5 | Public portal catalog lists role plays only | ✅ intended |
| A6 | Roles: owner/admin → `admin`, member → `user`; studio checks now admin/team | ✅ intended (API wording: see A1) |
| A7 | A learner invited by email gets a `member` row (role `user`) on first start, so they can also start any role play from `/talk` | ⚠️ Confirm this is wanted |
| A8 | Role-play invite routes and v1 assignments refuse twin agents | ✅ intended |
| A9 | Drafts / publish: persona found in the org first, then global; publishing over a twin with the same slug is refused | ✅ intended, additive |
| A10 | Interview agents labelled `ROLEPLAY`; global agents otherwise untouched | ✅ intended |

## B. v2 role play that must keep working

| Feature | Where | Guarded by |
|---|---|---|
| Scenario list, detail, Assign tab, edit | `app/dash/agents/*`, `components/spec-resource*`, `role-play-preview.tsx` | manual check |
| Create / edit a scenario (instructions → LLM spec), drafts, versions, publish | `app/api/agents/[slug]/generate`, `lib/spec-drafts.ts`, `lib/spec-generation.ts`, `app/api/spec-drafts/*` | `spec-draft` paths: none yet ⚠️ |
| Email invite → `/s/<code>` → one attempt, 30 days | `app/api/role-play/[slug]/assignments`, `lib/assignments.ts`, `app/(org)/s/[code]` | `assignments.test.ts`, `assigned-activation.test.ts`, `tests/sql/assigned-learner-session.sql` |
| Session start (talk page, portal, public API) and close | `lib/interview-sessions.ts`, `lib/session-activation.ts`, `app/api/sessions/*`, `app/api/v1/sessions` | `interview-sessions.test.ts`, `learner-session-access.test.ts` |
| Interview runtime in chat (session_plan, résumé questions, workspace tools) | `chat/agent/*` | chat test suite (92 tests) |
| Session report (score, key moments, focus next time) | `lib/generate-session-report.ts`, `lib/session-report*.ts` | `session-report*.test.ts` |
| Sessions list / detail, learners | `app/dash/sessions*`, `app/dash/learners`, `lib/learners.ts` | `learners.test.ts` |
| Fidelity report | `app/dash/agents/fidelity` | manual check |
| Role-play calibration pages (mock) | `app/dash/agents/[slug]/calibrate`, `/calibrations/[id]` | manual check |
| Public API: scenarios, assignments, sessions, users | `app/api/v1/*`, `docs/openapi.yaml` | `v1-users-contract.test.ts` (users role); scenarios / assignments / sessions ⚠️ no contract tests yet |

## C. Roleplay branch features to carry over (none of these may be dropped)

From `origin/feat/client-roleplay-mode` (`23eff6c`):

- **Client personas:** library + editor, 5 presets with avatars, fields (role, age, based in, background,
  behaviours, difficulty, opening style, formality, answer length, interrupts, pauses, fillers, signature phrases,
  how they talk, voice, pace), per-persona knowledge (documents / sources). `lib/client-persona*.ts`,
  `app/api/client-personas/*`, `components/client-persona/*`, `public/roleplay/avatars/*`.
- **Builder:** situation, hidden truth, learner role, ≤5 goals, agrees / declines when, persona, client name,
  character role, difficulty, how they talk, guarded-if / opens-up-if, opening, what to expect, voice, rubric
  (presets, ≤8 criteria, 100 points); deterministic spec (no LLM). `lib/roleplay.ts`, `lib/roleplay-drafts.ts`,
  `components/roleplay-builder.tsx`.
- **Builder assistant:** fill from a description; scenario from recent activity. `lib/roleplay-assistant.ts`,
  `app/api/roleplay/assist`.
- **Runtime:** CLIENT ROLE-PLAY MODE prompt (guard levels, reveals, end conditions), `end_call`, trainer tools
  disabled, persona knowledge passages. `chat/agent/lib/roleplay.ts`, `chat/agent/tools/end_call.ts`,
  `web/lib/session-context.ts` (`personaKnowledge`).
- **Reports:** role-play prompt; goals met / partly / missed; rubric points; pass; biggest opportunity; what went
  well; consistency rules; scored from the session snapshot. `lib/generate-session-report.ts`, `lib/session-report.ts`.
- **Pages:** scenario list and overview (sessions, score trend, this week), role-play sessions, session report,
  role-play users, role-play sidebar. `components/scenario-*.tsx`, `components/roleplay/*`.
- **Org type:** `SALES` / `TECHNICAL_INTERVIEW`, `DisplayForOrg`, wording map, founder invite field, scripts.
- **Copilot:** `save_roleplay_draft`, organization instructions, roleplay schema.
- **Seed:** `web/data/roleplay/seed.yaml`, `scripts/import-roleplay.ts`.
- **Tests:** `web/tests/lib/roleplay.test.ts`, `chat/tests/agent/lib/roleplay.test.ts`.

## D. Rules for the role-play work

1. **Nothing is deleted** in a change that adds something. A removal is its own commit, and only after you agree to it.
2. **Database changes only add.** No dropped or renamed columns; JSON keys are only added, and readers accept
   the old shape as well as the new one.
3. **The public API (`/api/v1`) contract is frozen**: `docs/openapi.yaml` is the reference. Any change to it is
   versioned and documented, and only with your agreement.
4. **Before touching a feature in B that has no test, add one** that captures today's behaviour first.
5. **Port C one feature per commit**, bringing the branch's own tests along, and check B after each one.
6. **Migrations:** back up, dry-run on a prod dump, then run for real.
