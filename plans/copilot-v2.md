# Copilot v2: in sync with the studio, studio actions, incremental skill updates, file picker, slash skills

Status: plan (2026-11-05). Execute phase by phase; each phase ships on its own.

## Where we are (verified 2026-11-05)

- `b6167ab` (Oct 26) replaced the old spec copilot with the scenario-ingest agent "copied as-is". It removed the studio
  link (`lib/studio.ts`, `studio_inventory`, `read_spec`, `read/save/publish_spec_draft`, `search_knowledge`, web tools).
- Copilot prod (`copilot.trainertwin.com`, Vercel `trainer-twin-copilot`) is up: `/eve/v1/health` ok, `/eve/v1/info`
  401 without auth, 200 with org Basic auth. Tools today: `files search read build_scenario check publish
  build_twin_skill publish_twin_skill` + sandbox `bash glob grep read_file write`. Skills: `twin-creator`, `roleplay-creator`.
  It reads the org knowledge base via web `/api/internal/knowledge-sources` and publishes via `/api/internal/scenarios`,
  `/scenario-runs`, `/twin-skills`. It has **no** studio read/write API.
- Web chat UI (`components/copilot-chat.tsx`) is still the spec-draft UI: blueprint panel, `DraftView`,
  `/api/spec-drafts/current` fetches, tool titles for removed tools, `takeCopilotSeed` (no producer left).
  Studio actions `inventory readSpec readDraft saveDraft publishDraft` in `/api/copilot/studio` serve only the old copilot.
- Traffic: no `/eve/v1` requests reached the copilot in the last 7 days; last `copilot` usage row is 2026-10-29.
- Config to verify (values are Vercel "sensitive", unreadable from the CLI):
  - studio `EVE_ORIGIN`: the local `web/.env.prod` says `https://chat.trainertwin.com` (the voice/chat brain!). Prod must be
    `https://copilot.trainertwin.com`.
  - copilot `STUDIO_URL` = `https://dash.trainertwin.com`, `SCENARIO_INGEST_SECRET` = studio's (the local `.env.prod`
    secret gets 401 from `/api/internal/knowledge-sources`, so local files are stale; prod published Olga's skills on Oct 28).
- Tests: `web` scenario-ingest + contract tests 48/48 pass; copilot `node --test` 1/1, `tsc` clean.
- Published skills keep every version's SKILL.md, manifest, `items.json`, `patterns.md` in S3 (`storeSkillAgent`), plus
  `SpecVersion` rows: a baseline for incremental updates exists.
- Role plays come in two kinds: copilot-built (`data.source = "scenario-ingest"`, SKILL.md + items) and builder-built
  (`saveRoleplay`, structured builder fields + `before` + `tools`, the workspace-tools work already landed).

## Decisions (2026-11-05)

1. **People: learners only.** The copilot can give, change and revoke learner access (twins, role plays). It never
   invites, changes or removes studio members (admin / team). Assign tools refuse an email that belongs to a studio
   member of the org.
2. **Deletes are always soft.** No copilot action hard-deletes anything; everything it removes can be restored.
3. **Where soft delete is missing, add it first** (see "Soft delete" below) rather than letting the copilot hard-delete.
   Read as: #2 wins over a hard-delete fallback. If you meant "hard-delete where there is no soft delete", the copilot
   just doesn't get a delete for those objects until the migration lands.
4. **File picker: existing knowledge-base items only** (no upload from the composer yet).
5. **Slash menu: skills only, two entries:** Twin skill (`twin-creator`) and Role play (`roleplay-creator`).

## Soft delete: what exists, what to add

| Object | Today | Plan |
|---|---|---|
| Learner twin access (`TwinAssignment`) | `status active / revoked` | use as is (revoke / restore) |
| Twin share link (`TwinShareLink`) | `status active / disabled` | use as is |
| Learner role-play access (`RolePlayAssignment`) | `cancelled` status exists, but `DELETE /api/role-play/[slug]/assignments` and `DELETE /api/v1/assignments/[id]` hard-delete | switch both routes to `status: "cancelled"`; lists already filter by status |
| Twin skill / role play (`Agent`) | none; `deleteSpec` hard-deletes the agent and its `SpecVersion` history (sessions block it via `onDelete: Restrict`) | add `Agent.archivedAt`; archive = hide from lists, twin playbooks, share links and new sessions; restore clears it; versions and S3 artifacts kept |
| Knowledge doc (`KnowledgeDocument`) | none; row + S3 files hard-deleted | add `KnowledgeDocument.deletedAt`; hidden from lists, `knowledge-sources`, picker; S3 kept (not a copilot action in v1, but the studio delete should use it too) |
| Session (`InterviewSession`) | `deletedAt` | not a copilot action |

The studio UI's own delete buttons move to the same soft paths, so the copilot and the pages agree.

## Phase 0: web and copilot in sync (blocker for everything else)

1. **Prod wiring.** Set studio `EVE_ORIGIN=https://copilot.trainertwin.com`; confirm copilot `STUDIO_URL` and
   `SCENARIO_INGEST_SECRET` match the studio; refresh `web/.env.prod` / `copilot/.env` locally so they stop lying.
   Smoke test in prod: "list my files" → copilot lists Olga's 120 docs incl. "Session 2 Objection Handling Workbook".
2. **Remove the spec-draft layer from the web.** In `copilot-chat.tsx`: blueprint panel, `DraftView`, `findDraftTarget`,
   spec-draft fetch, `takeCopilotSeed`; `lib/copilot-handoff.ts`; old `TOOL_TITLES`. In `/api/copilot/studio`: drop
   `inventory readSpec readDraft saveDraft publishDraft` after grepping chat/agent for callers (none today).
   Keep `/api/spec-drafts/*` only if the agents (interview) editor still uses them.
3. **Render today's tools well.** Titles for `files search read build_* check publish*`; a result card for publish
   ("Objection Handling saved as v2 · open"), and the check reasons when a build fails.
4. **Fresh knowledge.** The sandbox caches the KB inventory per session (`.inventory.json`), so a doc uploaded mid-chat is
   invisible. Have `knowledge-sources` return a version (max `updatedAt` + count) and re-sync when it changed.
5. **Org-scoped outputs.** `pushOutput` keys `output/<user>/...` by the model-supplied `user` string. Key by the session's
   principal org id (+ persona) so two orgs with the same persona slug can't collide.
6. **Contract tests.** Extend `scenario-ingest-contract.test.ts` for every endpoint the copilot calls (incl. the new ones
   below); one copilot test that every studio call carries the principal's org, never a model-supplied one.

## Phase 1: studio API for the copilot (create/update settings, people)

**Web.** One internal endpoint, `/api/internal/copilot-studio` (Bearer `COPILOT_SERVICE_SECRET`, org from
`x-trainertwin-org-id`, acting user from `x-trainertwin-user-id`; the proxy already sets both). Action-based like the chat's
studio route. First move the logic out of the tRPC procedures into `lib/` functions so tRPC and copilot share validation:

| Action | Reuses |
|---|---|
| `listTwins`, `listRoleplays` (with their skills, versions, people counts) | twin/roleplay `list` |
| `getTwin` (name, description, settings, assignments + minutes) | twin `get` |
| `getRoleplay` (builder fields, `before`, `tools`, assignments) | roleplay `get` |
| `getSkill` (current SKILL.md, manifest, items, patterns, version, source doc ids) | S3 artifacts of the agent |
| `listKnowledge` (id, title, ext, createdAt) | knowledge list |
| `updateTwin` (name, description, settings) | twin `update` |
| `updateRoleplay` (builder fields, `before`, `tools`) | roleplay `save` / `saveSettings` |
| `assignTwin` / `assignRoleplay` (learner emails, minutes, accessUntil; sends invites; refuses studio members) | `assignTwinAndInvite`, role-play assignments route |
| `updateAccess` (minutes; revoke/restore = soft) | `updateTwinAssignment`, role-play `cancelled` |
| `archive` / `restore` (twin skill, role play) | new `Agent.archivedAt` |
| `shareLink` (create / disable) | twin `shareLink`, `TwinShareLink.status` |

Not exposed: anything about studio members, personas, knowledge deletion, hard deletes.

**Copilot.** Tools `studio_list`, `studio_get` (read-only) and `update_twin`, `update_roleplay`, `assign_learners`,
`update_access`, `archive_item` with `requiresApproval: true`; the chat UI already renders `tool-approval` requests. The
approval card shows the change as a diff ("Name: X → Y", "Invite a@b.com · 60 min", "Archive: Objection Handling").
A third skill, `studio-admin`, says when to read first, to show the change before writing, and what never to do
(no studio members, no hard deletes). It is reached by plain requests, not the slash menu (decision 5).

## Phase 2: update an existing skill on top of what's there

1. **Load the baseline.** `load_skill({ kind: "twin" | "roleplay", slug })` pulls the current version's SKILL.md, manifest,
   items, patterns (via `getSkill`) into the sandbox, plus the doc ids it already cites.
2. **Update mode in the build tools.** `build_twin_skill({ mode: "update", base: slug, add: [...items], remove:
   [{ id, reason }], body })`: items = baseline − removed + added, de-duplicated; the skill id is locked to the baseline
   (no accidental second skill); every removal needs a reason; the check runs on the merged result. Same for
   `build_scenario` (copilot-built role plays). Builder-built role plays are edited through `update_roleplay` instead.
3. **Diff before publish.** The tool returns a changelog: items added/removed per situation, sections changed, new
   sources. The copilot shows it and publishes on approval; `storeSkillAgent` already makes it v(n+1) and keeps v(n).
4. **Skill text.** Add "Update an existing skill" to `twin-creator` and `roleplay-creator`: load → find what's new
   (selected docs, or KB docs newer than the version / not cited) → read only those → add items → revise sections →
   diff → publish. "Build from scratch" stays for new skills.
5. **Entry point in the studio.** "Update with copilot" on a twin skill / role play page opens the copilot with the
   skill command and that skill preselected.

## Phase 3: composer (file picker, slash skills)

1. **Files picker** (ChatGPT "Files" popover), existing knowledge only: a "Files" button in the composer; searchable
   list of the org's KB docs (icon by type, checkmarks, "Browse all" → Knowledge page; archived docs hidden). Picked docs
   show as chips. Sent as a structured block the UI hides and renders as chips (e.g. `<selected-files>` with doc ids).
   Copilot: selected docs are the sources to read first; force a re-sync if one isn't in the sandbox yet.
   Later: `@` mentions, upload from the composer.
2. **Slash skills, two entries only.** `/` opens a "Skills" menu: **Twin skill** (`twin-creator`) and **Role play**
   (`roleplay-creator`). The choice shows as a chip; the message carries `<use-skill name="twin-creator">` so the
   copilot loads that skill. New vs update: the copilot asks ("a new skill, or update Objection Handling / When the
   client goes silent?") from `studio_list`, then uses update mode for an existing one. Other `/` text is sent as typed.
   Later: a submenu to pick the existing skill directly.
3. Build both on the existing composer (or ai-elements `PromptInput`, already in the repo's skills); keyboard
   navigation, Esc to close, works in the side panel variant too.

## Phase 4: acceptance

- Olga uploads a doc → `/` Twin skill → Objection Handling → picks the workbook → copilot loads v1, adds items from the
  workbook only, shows the diff, publishes v2 on approval → the twin's next call uses v2; v1 remains in history.
- "Rename the Objection Handling twin to 'Objections & Pushback'" → approval card → name changes in the studio.
- "Give cathy@… 30 minutes on Olga's twin" → approval card → invite sent, shows on the twin's people tab.
- "Add olga's teammate as an admin" → refused (studio members are out of scope).
- "Remove the When the client goes silent skill" → approval card → archived (hidden, restorable); its versions remain.
- Revoking a learner's role-play access sets `cancelled`; the row is still there.
- A doc uploaded mid-chat is visible without starting a new chat.
- No copilot call can read or write another org's data (contract test).

## Final decisions (2026-11-05, implementation)

- **Approval card** for every twin / role-play change (settings, skill update publish) and for archive. **No card for
  inviting learners.**
- **Learners: invite only.** No tool to remove learners, change their minutes/access, or change anyone's role.
- **Archive must be restorable** (`Agent.archivedAt`, restore clears it; versions + S3 artifacts kept).
- **Update mode may remove baseline items** (with a reason). Every published version keeps its own S3 copy of SKILL.md,
  manifest, items.json and patterns.md, so any version can be restored.
