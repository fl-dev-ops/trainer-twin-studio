# Moving v2 to production: release brief

Compared with `main` (what prod runs). Facts come from the code diff, the prod dump of 27 Oct (`plans/prod-migration.md`), the local replica, and test runs.

## 1. Services and deploy order

| # | Service | Where | Why this order |
|---|---|---|---|
| 0 | **Database** | Neon | Backup (Neon branch), then the migration runbook (§5) |
| 1 | **web** | Vercel (`web/vercel.json`, region bom1) | New tables and columns; new internal endpoints the others call |
| 2 | **chat** | Vercel (`chat/vercel.json`) | Reads web's new session context (persona brief, twin skills); tolerates an old web |
| 3 | **copilot** | eve (Vercel Sandbox in prod) | Needs web's `/api/internal/knowledge-sources` and `/api/internal/twin-skills` |
| 4 | **voice agent** | LiveKit Cloud | TTS fallback only; independent |

## 2. Breaking changes

### A. Public API `/api/v1`
**Who's affected:** careerwithvasanth's API key is in use (18 calls, last 17 Oct 2026). Confirm which endpoints that integration calls before release.

| Change | Before → after |
|---|---|
| `POST /v1/sessions`, `DELETE /v1/sessions/:id` | Removed → **405**. Sessions are read-only; practice starts in the app |
| `domainSlug` (scenarios); `domainSlug`, `domainVersion` (sessions) | Fields removed (domains dropped) |
| `/v1/*` | **Role plays only**: twins are never listed or returned |
| `DELETE /v1/users/:id` | Deletes the user → **disables the learner**: signs them out, revokes their assignments and sessions |
| Re-inviting a disabled learner | → **409** |

### B. Roles and members
- `owner` / `member` / `ADMIN` become `admin` / `team` / `user`.
  - `admin` and `team` run the studio; `user` only practises.
- **One admin per org.** Prod's careerwithvasanth has two (Vasanth plus `diag-admin2@acme.com`); see runbook fix #3.
- Members can't be removed, only disabled. A second admin can't be created.

### C. Database: 12 migrations
Among them: the twin/role-play split, roles, twin access and calibration, disabled members, persona media and the avatar photo.

**Irreversible without the backup:** `drop_domains_2` drops the Domain table, `Agent.domainSlug`, the session domain columns, `SpecDraft.domainData` and the domain version history. Their content moves onto each agent first (`drop_domains_1`).

### D. Knowledge
- **Ingestion is paused.** New uploads are stored (original plus Markdown) but **not indexed into Chroma**.
  - Documents already indexed in prod keep working.
  - A **technical-interview** role play needs an indexed knowledge base, so it can't use new uploads.
- Drive import is new: one-time, for selected files only.

### E. Copilot
- **Studio sessions read the org's knowledge base**, no longer the `INGEST_S3_BUCKET` `users/<user>/` folder.
- **Two creators:**
  - `roleplay-creator` publishes **role plays** (they used to land as twins);
  - `twin-creator` publishes twin skills through a new endpoint.
- The model is Cerebras `qwen-3.8-27b` (128K context). The old spec-design copilot's OpenRouter and Firecrawl variables are no longer read.

### F. Pages and URLs
| Before | After |
|---|---|
| `/profile` | `/settings` (tabs: Account, Team, Branding) |
| `/users` | Removed; now under Settings → Team |
| `/knowledge` | Redirects to `/twin/knowledge` |
| `/domains` | Redirects to `/agents` |

### G. What the AI is told
- The chat prompt gets the **persona brief**:
  - role-play characters: the full brief;
  - the trainer's own persona: identity only.
- The DOMAIN block is gone; the rubric reaches the prompt through the agent.
- A single twin skill now **advises** (no session plan).

## 3. Feature status

**Working, verified locally**

| Feature | How verified |
|---|---|
| v1 API (read-only, role plays only) | Contract tests |
| Members: disable, one admin, invites | Tests, smoke test |
| Settings (Account, Team, Users) | Smoke test |
| Knowledge upload (two S3 copies) | Tests |
| Google Drive import | **You, end to end** |
| Twin's brain: Knowledge card, voice and avatar capture, headshot | Smoke test; your commits |
| Persona Library and editor | Tests, smoke test |
| Persona media (voice, avatar, photo on call screens: `/calibrate`, `/talk`, `/s`, `/t`) | Smoke test |
| Persona brief in the chat prompt | Tests |
| Twin share links (`/t/…`), share dialog, Copy link | Your work; render check |
| Twin access by minutes | SQL tests |
| Calibration | SQL tests |
| Copilot reads the KB (sandbox sync, 40 sessions) | **Live** |
| **twin-creator** | **Live: two skills published in the olga replica** |
| roleplay-creator | Contract tests only, no live run |
| Domains dropped (session start without a domain) | Before/after snapshot |
| Prod migration | **Rehearsed on the prod dump**, with the 3 fixes in §5 |

**Partial or not built**

| Gap | State |
|---|---|
| "Twin for all use cases" (all-skills twin) | **No UI to create it** (`POST /api/twins` exists) |
| Twin's brain: Training style card | Mock |
| Persona pace | Stored, not used by the TTS |
| Copilot role plays in the Scenarios library | Not listed (runnable from `/talk`) |
| Twin items in their own Chroma collection | On hold; they use the `main` collection |
| Knowledge ingestion into Chroma | Paused (see 2D) |

**Not verified (do before release)**
- **A live voice session on v2**, for:
  - a role play (one of Vasanth's);
  - a twin skill;
  - the all-skills twin.
- Copilot on **Vercel Sandbox** (only the local just-bash sandbox has run).
- AI spec generation since the domain → rubric rename (no real generation has run).

**Known test failures (all present before v2)**
- web: 4 runtime E2E suites, "S3 keys are rooted by immutable organization ID", and a leak between test files ("admin and team are let in").
- agent: the session test needs `SARVAM_API_KEY`.

## 4. Environment changes

### web (Vercel)
| Variable | | Notes |
|---|---|---|
| `SCENARIO_INGEST_SECRET` | **New, required** | Shared secret for copilot → web (`/api/internal/*`); same value in copilot |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` | New (Drive import) | OAuth client (PKCE), `drive.file` scope |
| `GOOGLE_DRIVE_REDIRECT_URI` | New | **The prod callback URL** (local uses the localhost bridge), registered on the OAuth client |
| `GOOGLE_DRIVE_PICKER_API_KEY`, `GOOGLE_DRIVE_PROJECT_NUMBER` | New | **Restore the key's website restrictions** to the prod domains |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` | New | Random 32 bytes; encrypts the short-lived Drive cookies |
| `AVATAR_IMAGE_MODEL` | Optional | Headshot model, default `google/gemini-3.1-flash-image`; uses the existing AI Gateway / OpenRouter key |
| `EVE_ORIGIN`, `COPILOT_SERVICE_SECRET` | Existing | Must point at the deployed copilot |

### copilot (eve deployment)
| Variable | | Notes |
|---|---|---|
| `SCENARIO_INGEST_SECRET` | **New, required** | Same value as web |
| `STUDIO_URL` | Existing, **required** | The prod web URL |
| `CEREBRAS_API_KEY` | **New, required** | Developer tier (128K context, 150K tokens/min) |
| `INGEST_S3_BUCKET`, `INGEST_S3_PREFIX`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | New | Where run outputs are archived |
| `COPILOT_SERVICE_SECRET` | Existing | Unchanged |
| `OPENROUTER_API_KEY`, `SPEC_COPILOT_MODEL`, `FIRECRAWL_API_KEY` | **No longer read** | Remove |
| `INGEST_USERS`, `INGEST_OUTPUT` | Local only | Don't set in prod |

### chat
No new variables.

### voice agent (LiveKit)
| Variable | | Notes |
|---|---|---|
| `AGENT_FALLBACK_VOICE_ID` | Optional | Defaults to `charlotte-sample`, which **exists in prod** |
| `TTS_SERVICE_URL`, `TTS_API_KEY` | Existing | Prod TTS resolves voices from the prod app; a persona's cloned voice works once it exists in prod |

## 5. Pre-flight and data

1. **Backup:** a Neon branch. Use the **direct** (non-pooler) URL for migrations.
2. **Runbook** (`plans/prod-migration.md`), rehearsed on the dump:
   - fix #1: schema drift on `add_learner_reports_session_evaluation` (resolve as applied, plus one ALTER);
   - fix #2: 3 orphan session → assignment links (NULL them, then add the foreign key);
   - `prisma migrate deploy`;
   - fix #3: careerwithvasanth's second admin. Decision: `diag-admin2@acme.com` becomes `team`.
3. **Files under the dev S3 prefix** in prod data: latencytest's 38 documents and Vasanth's voice files live under `trainertwin-dev/kb/…`. Copy them to the prod prefix (and update the keys), or never clean up the dev prefix.
4. **Optional:** set Vasanth's `Persona.voiceId` to his voice (it's only on his agents today).
5. **Secrets:**
   - rotate the Neon password (it was shared in chat);
   - replace the AWS key ID in `plans/issues_agent-llm-routing.md` on `main` (only the ID is exposed; the secret there is a placeholder).

## 6. Decisions needed

| # | Decision |
|---|---|
| R1 | v1 API: is careerwithvasanth's integration using `POST /v1/sessions` or `domainSlug`? If so: notify them, or keep a compatibility shim for one release |
| R2 | Ship with knowledge ingestion paused, or re-enable it for role-play knowledge first? |
| R3 | Release Olga's org at the same time? It doesn't exist in prod: founder invite, uploads, persona, then twin-creator runs |
| R4 | Build "Create twin" (all-skills twin) before release? |

## 7. Release log (28 Oct 2026)

- **Backups:**
  - Neon branch `backup-pre-v2-2026-10-28` (`br-wandering-cherry-azgw2nr5`);
  - `~/Backups/trainertwin/prod-neondb-20261027T2245Z.dump`, verified (39 tables, 2,576 rows).
- **Production env vars added:**
  - web: `SCENARIO_INGEST_SECRET` and the 6 `GOOGLE_DRIVE_*`;
  - copilot: `SCENARIO_INGEST_SECRET`, `CEREBRAS_API_KEY`, `INGEST_S3_*`, `AWS_*`.
- **Vercel:**
  - web, chat and copilot: Production branch `main` → **`v2`**;
  - `autoAssignCustomDomains` off until the migration is done, then promote.
  - CLI deploys were blocked (the commit author isn't a team member), so builds come from GitHub.
- **Voice agent:** stays on v1.

**Done (28 Oct 2026, ~05:10 IST)**
- **Migrations:** 13 applied, plus fixes #1–#3. One more than planned: `20261029030000_calibration_score` (3 nullable columns, part of v2).
  - Fix #2 must run *after* `migrate deploy`. Before it, the session-org trigger rejects the UPDATE: the learners aren't members yet.
  - Result: schema up to date; Domain table gone; assignment FK in place; careerwithvasanth's only admin is victorywithvasanth@gmail.com; its 10 role plays are intact (ROLEPLAY, with principles).
- **Promoted:**
  - web `dpl_BKcLWrnVbM6y1BFDLjakTcUpw26P` (dash, auth, `*.trainertwin.com`);
  - chat `dpl_9eMRMSQnmEULTzDgLJfqQCJqMHeS`;
  - copilot `dpl_4JFc4zSQjbDTVhaJdQdqNMAon3d5`.
  - All built from v2 `bc663d0`.
- `autoAssignCustomDomains` is back on. **Production branch = v2** on all three projects: every push to v2 now deploys production.
- **Olga:** org `olga` (`bc657406-6209-4bb8-af6f-c0d8141a17a4`) with her own persona only (voice and avatar in the prod S3 prefix). No members, agents or documents yet.
- **Rollback:**
  - instant: promote the previous deployments (web `dpl_4UWrb75pumgSEXMuv5MQp4MogeFc`, chat `dpl_8o5uwaJdKmXjcQBgogrSEKud7QGq`, copilot `dpl_8G149rgZXByWQ7hRDBut6MGfbqnC`);
  - database: restore from branch `backup-pre-v2-2026-10-28`. The old code does not run on the new schema.
