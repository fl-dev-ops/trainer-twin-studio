# Copilot

> The studio copilot helps a trainer turn their knowledge into twin skills or practice role plays. It can also read the studio, change a twin or role play's settings, invite learners, and archive or restore skills and role plays. The web app supplies the signed-in trainer and organization; the separate `copilot/` Eve app does the conversation and calls narrow studio endpoints. Building and changing content use tools, source checks, and approval cards, not the old blueprint editor (`copilot/agent/instructions/copilot.md`, `web/components/copilot-chat.tsx`, `web/lib/copilot-studio.ts`).

## Who uses it

| Role | Access |
| --- | --- |
| Org admin (`admin`) and team (`team`) | Same copilot access, in their enabled studio organization. They can read, build, approve changes, invite learners, archive and restore. |
| Learner (`user`), disabled member, unauthenticated visitor | Cannot use the studio copilot through its identity endpoint or Eve proxy. |
| Copilot service | Calls internal studio actions with a service secret and the session's org and acting trainer. The internal action route rechecks enabled admin/team membership. |
| Local developer / deployment operator | Eve also accepts `localDev()` and `vercelOidc()` authentication. These are not studio role grants; studio actions require an organization principal and acting trainer. |

Sources: `web/lib/org.ts` (`isStudioRole`, `enabledMemberships`, `getTrainerOrg`), `web/app/api/copilot/me/route.ts` GET, `web/app/api/eve/v1/[[...path]]/route.ts` (`proxy`), `web/app/api/internal/copilot-studio/route.ts` POST, `copilot/agent/channels/eve.ts`, `copilot/agent/lib/studio.ts` (`studio`). See [Organizations and roles](orgs-and-roles.md) for membership and per-tab org selection.

## Words used here

| Term | Meaning |
| --- | --- |
| Studio | The trainer-facing web app. |
| Copilot / Eve | `copilot/` is the separate agent app, running on the Eve framework. `/api/eve/v1/...` is the web proxy to it. |
| Principal | The authenticated identity on an Eve session. Studio sessions use `principalType: "organization"`, `principalId: orgId`, plus the acting `userId`. |
| Twin skill | One topic of the trainer's knowledge, decisions and approach. Used to advise a learner, not to run a rehearsal. |
| Role play / scenario | A practice the AI leads. It may be built from recordings or edited as structured builder fields. |
| Main twin | The trainer's all-skills twin (`Agent.kind = TWIN`, `data.source = "twin"`), distinct from a twin skill. |
| Tool / skill / instructions | A callable operation; a loaded procedure for a task; the shared and dynamic context the model follows. Agent skills here are not the published twin skills. |
| Sandbox | The session's working files, including copied sources and generated outputs. |
| `user` | A persona-style sandbox folder name supplied to build/read tools, not the signed-in account or the authorization boundary. |
| Before / Tools | Settings for screen sharing and uploads; role-play workspace capabilities (canvas, code editor, preview, choice). |
| Knowledge file / attachment | A persistent knowledge-base source; a temporary file attached to a copilot conversation. They are separate. |
| Approval card | Eve's tool interaction asking the trainer to approve a proposed write before the tool executes. |

Sources: `copilot/agent/instructions/copilot.md`, `copilot/agent/instructions/studio.ts`, `copilot/agent/lib/tenant.ts`, `web/lib/copilot-studio.ts` (`kindOf`, `copilotStudioInput`), `copilot/agent/tools/update_roleplay.ts`.

## Data

- **`CopilotSession` / `copilot_session`**: `sessionId` is the unique Eve session ID; `orgId` and `userId` identify its owner; `title` is at most 120 characters; `createdAt` records creation. The proxy upserts the owner on successful session creation with an empty update, so a reused ID cannot change owner. The title comes from the first message with composer tags removed, or `New conversation` (`web/prisma/schema.prisma` `CopilotSession`; `web/app/api/eve/v1/[[...path]]/route.ts` `titleOf`, `proxy`).
- **Browser state**: one saved `{sessionId, streamIndex}` in local storage per user + org; unsent text in session storage per user + org. New conversation removes those local keys, not the server session. A queued `seedCopilot` message starts a fresh conversation. Legacy browser-wide keys are discarded (`web/lib/copilot-handoff.ts`; `web/components/copilot-chat.tsx` `CopilotChat`, `newConversation`).
- **Working files**: source inventory and source copies under `users/<user>/`; build artifacts under `output/<user>/`. Twin packages have `SKILL.md`, `skill.json`, `items.json`, `patterns.md`; role-play packages use `scenario.json` instead of `skill.json`. Twin updates also track the loaded baseline and changes (`copilot/agent/lib/ingest.ts` `ensureSynced`; `copilot/agent/lib/twin-skill.ts`; `copilot/agent/tools/load_skill.ts`). These are working state, not the authoritative published agent.
- **Published data**: handed to the twin/role-play ingestion layer. S3 stores versioned files, `Agent` holds current data and version, `SpecVersion` holds previous data, and Chroma holds searchable examples. Identical content keeps its version; changed content snapshots the old row and increments it. Archiving sets `Agent.archivedAt`; restoring clears it. This module does not hard-delete those records (`web/lib/scenario-ingest.ts` `storeSkillAgent`; `web/lib/copilot-studio.ts` `runCopilotStudio`). See [Twins](twins.md), [Role plays](roleplays.md).
- **Attachments**: shared `ContextDocument` records have `orgId`, `ownerUserId`, `purpose: "copilot"`, `s3Key`, `expiresAt`, extracted text and chunks. Lifecycle: pending → ready or failed; ready → expired; abandoned pending → failed. `startUpload` sets expiry to 30 days from creation (`web/lib/uploads.ts`; `web/prisma/schema.prisma` `ContextDocument`). See [Platform](platform.md) for shared storage.

## How it works

### Open, resume and send

1. The studio home renders `CopilotChat`; the component also supports a panel variant. It fetches `/api/copilot/me` before choosing the user's org-scoped browser keys (`web/app/dash/page.tsx`; `web/components/copilot-chat.tsx` `CopilotChat`).
2. Before resuming a saved session, the UI probes its stream. A 404/403 or `session_stranded` / `session_version_unsupported` drops the saved ID; transient errors keep it resumable. A queued seed also starts fresh (`web/components/copilot-chat.tsx` `resumable`, `CopilotChat`).
3. The composer offers two slash skills: Twin skill and Role play. Files selects existing knowledge documents, refetched whenever the picker opens, excluding failed documents. Picks become hidden `<use-skill ... />` / `<selected-files>` text blocks, rendered as chips/cards. They prioritize sources; they do not grant access or restrict the whole conversation to those documents (`web/lib/copilot-message.ts`; `web/components/copilot-composer.tsx` `KnowledgeFilePicker`; `copilot/agent/instructions/copilot.md`).
4. Attachments upload before sending (below). The UI sends the encoded text and file pointers. On a send failure it restores text, skill and selected knowledge files and shows an error; an upload failure stops the send (`web/components/copilot-chat.tsx` `send`).

### Cross the web/service boundary

1. The proxy requires `EVE_ORIGIN` and `COPILOT_SERVICE_SECRET` (503 otherwise), then resolves an enabled studio membership (401 otherwise). Org lookup is cached for 30 seconds per session cookie + tab org header (`web/app/api/eve/v1/[[...path]]/route.ts` `trainerOrgFor`, `proxy`).
2. Any `/session/<id>/...` request must match both `CopilotSession.userId` and `orgId`; non-owners receive 404. On `POST /session`, the proxy records ownership before returning the new ID, and checks ownership again if the ID already existed (`proxy`, `ownsSession` in that file).
3. It forwards to `${EVE_ORIGIN}/eve/v1/...` with Basic authentication `orgId:COPILOT_SERVICE_SECRET`, overwrites `x-trainertwin-user-id`, and removes cookies, host and tab-org headers. It preserves the query, streams the response, passes request cancellation, and strips upstream cookies. Fetch/persistence failures return 502 `Copilot is unavailable`; a successful creation without a string session ID returns 502 (`proxy` in that file).
4. Eve validates the Basic secret with a timing-safe comparison and creates an organization principal. `sessionPrincipal` refuses an organization different from the session initiator. The current caller's attributes supply the trainer (`copilot/agent/channels/eve.ts` `studioOrganization`; `copilot/agent/lib/tenant.ts` `sessionPrincipal`).
5. The `studio` helper calls `POST ${STUDIO_URL}/api/internal/copilot-studio` with **Bearer `SCENARIO_INGEST_SECRET`**, `x-trainertwin-org-id` from the principal, and `x-trainertwin-user-id` from its attributes. It refuses a non-org session, missing trainer or missing configuration. The model cannot choose the authorization org (`copilot/agent/lib/studio.ts`).
6. The internal route validates the ingest secret, both headers, enabled admin/team membership, and a strict action schema, in that order. It passes an actor derived from those records to `runCopilotStudio` (`web/app/api/internal/copilot-studio/route.ts`; `web/lib/copilot-studio.ts`).

### Build or update

1. Shared instructions distinguish twin knowledge from rehearsal. The agent loads `twin-creator` or `roleplay-creator`, lists existing items first, and asks if the intended product/target is unclear. Dynamic studio instructions supply org, trainer and own persona slugs; no persona means ask the trainer to set up their twin. A failed dynamic-context lookup is logged and retried on a later call (`copilot/agent/instructions/copilot.md`, `studio.ts`).
2. `files` synchronizes the org's knowledge Markdown into the sandbox. `search` and `read` supply numbered recording turns for citations. The loader fails on any failed download rather than building from a silent partial copy. Org sessions without studio configuration never fall back to local source folders (`copilot/agent/tools/files.ts`, `search.ts`, `read.ts`; `copilot/agent/lib/origin.ts` `pullKnowledgeBase`; `session-io.ts` `knowledgeBaseFor`).
3. The matching build tool writes the package and returns rejected evidence or check reasons. Checks cover source grounding, structure and privacy; the full detailed format belongs to [Twins](twins.md) and [Role plays](roleplays.md). Instructions require at least three relevant sources for a new twin skill, or three practice recordings for a new role play, and a bounded fix cycle (`copilot/agent/skills/twin-creator.ts`, `roleplay-creator.ts`; `copilot/agent/tools/build_twin_skill.ts`, `build_scenario.ts`; `copilot/agent/lib/twin-skill.ts`, `ingest.ts`).
4. For a twin update, `load_skill` loads the published version. The build keeps baseline items except explicit removals with reasons, deduplicates additions, locks the skill ID, and applies exact, single-match `find`/`replace` edits with reasons to the loaded text. Whole replacement body/patterns are refused in update mode. A successful studio publish rebases the sandbox for the next update (`copilot/agent/tools/load_skill.ts`; `copilot/agent/lib/twin-skill.ts` `mergeWithBase`, `applyEdits`, `saveTwinSkill`, `rebaseAfterPublish`; `copilot/agent/tools/publish_twin_skill.ts`).
5. For a recordings-based role play, loading writes reference files under `baseline/<slug>/`; rebuilding reuses the scenario ID by instruction, not a twin-style merge mode. A builder role play is changed through `update_roleplay` instead (`copilot/agent/tools/load_skill.ts`; `copilot/agent/skills/roleplay-creator.ts`; `copilot/agent/tools/build_scenario.ts`).
6. Both publish tools require approval and revalidate before copying allowed files out of the sandbox. Role plays can publish only the passing scenarios of a run, with rejection reasons for the rest; twin validation failure returns `published: 0`. Output-copy success alone is not studio success: results separately report what the studio accepted (`copilot/agent/lib/publication.ts` `preparePublication`; `copilot/agent/lib/twin-skill.ts` `prepareTwinPublication`; `copilot/agent/tools/publish.ts`, `publish_twin_skill.ts`).
7. The publisher sends run records and role plays, or a twin package, to ingestion endpoints. A changed version keeps earlier artifacts; publishing onto an archived item restores it. The stored agent is not switched to a new version until artifacts and example writes succeed (`copilot/agent/lib/studio-publish.ts`; `web/lib/scenario-ingest.ts` `storeSkillAgent`).

### Settings, invitations and removal

The `studio-admin` procedure says: find exact slug → read current state → change only requested fields → report the result. Twin/role-play updates, archive and restore all require approval. Declining should stop the proposed change, not cause a retry. Learner invitations run **without** approval and report added/assigned/skipped/refused recipients (no org invitation state) (`copilot/agent/skills/studio-admin.ts`; `copilot/agent/tools/update_twin.ts`, `update_roleplay.ts`, `archive_item.ts`, `restore_item.ts`, `invite_learners.ts`).

### Attach and expire a file

1. The composer permits images (PNG/JPEG/WebP) up to 5 MiB or PDFs up to 10 MiB. `uploadFile` starts a `purpose: "copilot"` upload, PUTs directly to a 10-minute S3 URL, then completes it. Completion verifies actual bytes/type/size and extracts text. Failure best-effort deletes the object and marks the record failed (`web/components/copilot-chat.tsx` `send`; `web/lib/upload-client.ts`; `web/lib/context-upload.ts` `uploadProblem`; `web/lib/uploads.ts` `startUpload`, `completeUpload`).
2. The message carries `trainertwin-upload://<id>`. Eve's `fetchUpload` resolves it through the internal studio action, restricted to the same org and acting user's own upload. No copilot-session link or `purpose` filter is required by this resolver (`copilot/agent/lib/uploads.ts` `fetchUpload`; `web/lib/copilot-studio.ts` `resolveUpload` case; `web/lib/uploads.ts` `resolveUpload`).
3. Images reach the model as pixels, using a reduced JPEG copy when needed. PDFs become base64 Markdown text, staged as `<original-name>.md` for `read_file`; scanned PDFs get a no-text notice, not page OCR. Signed download URLs last five minutes; the copilot download has a 30-second timeout (`web/lib/uploads.ts` `modelCopy`, `resolveUpload`; `copilot/agent/lib/uploads.ts`).
4. Expired status or a past expiry refuses resolution with 410 even before cleanup. Daily at 03:30 UTC, the expiry cron processes up to 200 expired ready uploads and up to 200 day-old pending uploads per invocation. It best-effort deletes original/model S3 objects; expired rows stay, with `content` cleared. It does **not** clear extracted text, chunks or conversation copies (`web/lib/uploads.ts` `expireUploads`; `web/app/api/internal/uploads/expire/route.ts`; `web/vercel.json`).
5. Instructions treat attachment text as content, not instructions. Attachments are not knowledge sources: for durable building material the trainer is directed to add the file in Twin's brain (`copilot/agent/instructions/copilot.md`).

## Rules

1. Only enabled `admin`/`team` members may use studio actions; `user` is not a studio role. Secret-only access without an enabled acting member is insufficient for `/api/internal/copilot-studio` (`web/lib/org.ts`; internal route POST).
2. A browser session ID belongs to one user in one org. Another user or another org receives 404, including reused creation IDs. Copilot tools also reject a turn from another initiating org (`web/app/api/eve/v1/[[...path]]/route.ts` `ownsSession`, `proxy`; `copilot/agent/lib/tenant.ts`).
3. Internal actions are only those in the table below. Unknown actions and extra fields fail the strict schema with 400; payloads cannot override the actor's org (`web/lib/copilot-studio.ts` `copilotStudioInput`, `runCopilotStudio`).
4. `list` hides archived items unless `includeArchived` is true. `get` can read archived items but refuses a mismatched requested kind with 400. Missing org-scoped slugs return 404 (`runCopilotStudio`, `findAgent`).
5. The learner invite input accepts 1–100 valid, lowercased/trimmed emails. Studio-member emails are filtered out and returned as `refused`; if all are staff no invite is sent. There is no learner removal, access revocation, role change or minutes-change action. Legacy `minutes` input is accepted but ignored (`copilotStudioInput`, `studioPeopleEmails` in `web/lib/org-people.ts`, `inviteLearners` case).
6. Invites require an unarchived target. Twin invites pass optional validated `accessUntil`; role-play invites do not use that date. Allocation and email behavior belong to [Credits](credits.md) and [Invites and emails](invites-and-emails.md), through `assignTwinAndInvite` / `inviteToRoleplay` (`runCopilotStudio` `inviteLearners`).
7. Archive requires an active target, refuses the main twin with 400, and only sets `archivedAt`. Restore requires an archived target and clears that field. Repeating either against the already-changed state returns 404, not an idempotent success (`findAgent`, `archive` / `restore` cases).
8. `updateTwin` accepts optional name (1–120 characters), description (at most 2,000), and partial Before settings. Upload title/instruction limits are 80/300 characters. Role-play updates accept builder fields, Before and Tools; shared manage functions perform domain validation (`copilotStudioInput`; `web/lib/twin/manage.ts` `updateTwin`; `web/lib/roleplay/manage.ts` `updateRoleplay`).
9. Update, archive, restore and publish tools request approval every time; `invite_learners` does not. This is enforced at the Eve tool boundary, not by an approval token on the internal HTTP route (`copilot/agent/tools/{update_twin,update_roleplay,archive_item,restore_item,publish,publish_twin_skill,invite_learners}.ts`; internal route POST).
10. A twin skill and a role play must not replace one another. Instructions choose separate builders/publishers; ingestion rejects an existing slug of the other kind or another org with 409 (`copilot/agent/instructions/copilot.md`; `web/lib/scenario-ingest.ts` `storeSkillAgent`).
11. The scoped `write` tool accepts only `specs/<kebab-id>.md` and `report.md`. Instructions forbid using shell writes or hand-writing published files, counting lines as turns, inventing evidence and exposing personal details. Shell access is nevertheless present; these are not all filesystem-enforced restrictions (see Mismatches) (`copilot/agent/tools/write.ts`; `copilot/agent/lib/files.ts` `writeTool`; `copilot/agent/instructions/copilot.md`).
12. The copilot has no tools/actions for session reports, calibration, studio members, org branding, voice/avatar/persona edits, knowledge upload/deletion, permanent deletion, share-link management, or learner access/minute changes. For unavailable tasks/data, instructions require “I can't … from the copilot yet. You can … in **[Studio section]**.” It must not infer that unseen data does not exist (`copilot/agent/instructions/copilot.md`; `web/lib/copilot-studio.ts` `copilotStudioInput`). Trainer-initiated temporary composer attachments remain allowed.
13. Upload limits apply again to verified bytes. Missing/pending/failed files resolve as 404; expired files as 410. Copilot resolution requires org and owner but not a particular conversation (`web/lib/uploads.ts` `completeUpload`, `resolveUpload`).

## Entry points

### Web

| Entry | Code / purpose |
| --- | --- |
| Studio home `/` (dash route tree) | `web/app/dash/page.tsx`; `web/components/copilot-chat.tsx` (`page` / `panel` variants). |
| GET `/api/copilot/me` | `web/app/api/copilot/me/route.ts`: current studio user and org IDs. |
| GET / POST `/api/eve/v1/[[...path]]` | `web/app/api/eve/v1/[[...path]]/route.ts`: authenticated Eve proxy, including creation, stream and tool interactions. |
| POST `/api/internal/copilot-studio` | `web/app/api/internal/copilot-studio/route.ts`: service-authenticated actions below; max duration 60 seconds. |
| GET `/api/knowledge/documents` | `web/app/api/knowledge/documents/route.ts`: composer knowledge picker; see [Knowledge](knowledge.md). |
| POST `/api/uploads`; POST `/api/uploads/[id]/complete` | Corresponding `web/app/api/uploads/` route files; temporary attachment creation/completion. |
| GET / POST `/api/internal/uploads/expire` | `web/app/api/internal/uploads/expire/route.ts`: shared expiry cron. Requires cron/internal secret on Vercel; no-secret local calls are allowed. |

### Allowed internal studio actions

All are POST JSON actions through `copilotStudioInput` / `runCopilotStudio` in `web/lib/copilot-studio.ts`.

| Action | Inputs and result / model tool |
| --- | --- |
| `context` | Org slug, trainer name, own personas; dynamic studio instructions. |
| `list` | Optional `kind: twin | roleplay`, `includeArchived`; slug, name, kind, skill ID, version, description, archived flag and update time. `list_twins`, `list_roleplays`. |
| `get` | Slug, optional kind; settings and learners; role plays add workspace tools and builder fields where applicable. `get_twin`, `get_roleplay`. |
| `getSkill` | Slug, optional positive version; skill text, manifest, items, patterns and version list. `load_skill`. |
| `listKnowledge` | Non-failed org documents: ID, title, extension, added date. Internal capability, not a dedicated model tool. |
| `resolveUpload` | Document ID; owner's attachment as signed URL or inline data. Eve file resolver, not a dedicated model tool. |
| `updateTwin` | Slug and partial name, description, Before settings. `update_twin`. |
| `updateRoleplay` | Slug and partial builder, Before, Tools. `update_roleplay`. |
| `inviteLearners` | Slug, emails, optional end date; invite result plus refused staff emails. `invite_learners`. |
| `archive` / `restore` | Slug; archived flag. `archive_item`, `restore_item` (tools also take a display name). |

### Copilot app

- `copilot/agent/agent.ts`: default tools disabled; explicit tools under `agent/tools/`. Source tools: `files`, `search`, `read`, `read_sessions`, `read_method`; builders/checks: `build_scenario`, `build_twin_skill`, `check`; publication: `publish`, `publish_twin_skill`; studio tools as above; sandbox tools: `bash`, `glob`, `grep`, `read_file`, `write`.
- Instructions: `copilot/agent/instructions/copilot.md` and dynamic `studio.ts`. Skills: `copilot/agent/skills/twin-creator.ts`, `roleplay-creator.ts`, `studio-admin.ts`. Only the first two appear in the slash menu (`web/lib/copilot-message.ts`).
- `copilot/agent/channels/eve.ts`: Eve channel authentication, attachment policy/resolution. `copilot/agent/sandbox.ts`: Vercel sandbox on Vercel, JustBash locally.
- `copilot/package.json`: `dev` (`eve dev --no-default-extensions`), `build`, `deploy`, `start`, `test`, `typecheck`.

## Talks to

| Boundary | What crosses it |
| --- | --- |
| Web → Eve | Requests/streams through `EVE_ORIGIN`, Basic `COPILOT_SERVICE_SECRET`, trusted org + trainer identity (`web/app/api/eve/v1/[[...path]]/route.ts`; `copilot/agent/channels/eve.ts`). |
| Copilot → studio actions | Bearer `SCENARIO_INGEST_SECRET`, org + trainer headers and strict actions. **Not** `/api/copilot/studio` (`copilot/agent/lib/studio.ts`). |
| [Knowledge](knowledge.md) → sandbox | GET `/api/internal/knowledge-sources`, including `?versionOnly=1`; ingest secret + org header. Markdown links last 15 minutes; fingerprint covers document IDs and update times. The helper checks it at most every 20 seconds per org and re-syncs on change (`web/app/api/internal/knowledge-sources/route.ts`; `copilot/agent/lib/origin.ts`, `session-io.ts`, `ingest.ts`). |
| Sandbox → output storage | S3 `INGEST_S3_BUCKET` / `INGEST_S3_PREFIX`, output under `output/<org>/<user>/...`; local fallback under `INGEST_OUTPUT/<user>/...` (`copilot/agent/lib/origin.ts` `pushOutput`). |
| Copilot → [Twins](twins.md) / [Role plays](roleplays.md) | POST `/api/internal/twin-skills`, `/api/internal/scenario-runs`, `/api/internal/scenarios`: validated package/run data, persona slug, sanitized session run ID; Bearer ingest secret + org. Replies identify stored slug/version or failure (`copilot/agent/lib/studio-publish.ts`; corresponding web routes; `web/lib/scenario-ingest.ts`). |
| Copilot → LLM | Cerebras `qwen-3.8-27b`, 128,000-token context, low reasoning. No configured session usage/time ceiling (`copilot/agent/lib/model.ts`; `copilot/agent/agent.ts`). |
| Copilot → usage ledger | Completed model calls emit org/user-attributed token deltas, source `copilot`, Eve idempotency key. Trace policy excludes input/output recording (`copilot/agent/instrumentation/context.ts`, `usage.ts`; `copilot/agent/lib/usage.ts`). See [Platform](platform.md). |
| Invites → email/credits | Shared assignment helpers call addPeopleToOrg before required-member assignments, then queue one combined person email (readable twin /t/ URL or personal role-play /s/ URL, plus added/credits when new); the copilot reports their results (`web/lib/copilot-studio.ts` `inviteLearners`). See [Invites and emails](invites-and-emails.md), [Credits](credits.md). |

`web/app/api/copilot/studio/route.ts` is a different service surface used by the live chat runtime: retrieval, session context and workspace/session actions, authorized by Bearer `COPILOT_SERVICE_SECRET` plus org. Its name is not evidence that studio copilot can use those actions; see [Voice agent and chat](voice-agent-and-chat.md) and `chat/agent/lib/studio.ts`.

## Edge cases and limits

- Internal actions: wrong secret → 401; missing org/user → 400; missing/disabled/non-studio member → 403; invalid action → 400 with at most five schema issues. Domain errors preserve their status; unexpected failures log and return 500 `The studio action failed`. `studioResult` returns `{error}` for the model to report, not a success (`web/app/api/internal/copilot-studio/route.ts`; `copilot/agent/lib/studio.ts`).
- Approval waits count as the trainer's turn, not model busy time. Buttons lock after one response and unlock if the response fails. Model-call failure has a plain “temporarily unavailable” alert (`web/components/copilot-chat.tsx` `CopilotConversation`, `ToolPartView`).
- Model-start HTTP 429 gets one abortable retry, waiting at most 60 seconds using `retry-after`; quota/billing/daily-limit errors and longer waits fail visibly. Eve owns retries after a stream opens (`copilot/agent/lib/model.ts` `isRateLimit`, `waitOnRateLimit`).
- Studio run-record failure does not stop the role-play publisher from trying individual scenarios. Each scenario reports its own success/error. Twin HTTP errors return `ok: false`; transport failures can still throw. Publishing is not one transaction across output copies, run record, S3, Chroma and Postgres (`copilot/agent/lib/studio-publish.ts`; `copilot/agent/tools/publish_twin_skill.ts`; `web/lib/scenario-ingest.ts` `storeSkillAgent`).
- `getSkill` requires stored skill text and artifact prefix, otherwise 404. Individual S3 read errors are swallowed: absent manifest falls back to stored scenario, absent items to `[]`, patterns to null. Malformed downloaded JSON can still cause 500 (`web/lib/copilot-studio.ts` `getSkill`).
- The proxy's explicit shortcut is per-instance 30-second membership caching. Internal studio actions still recheck membership every call (`web/app/api/eve/v1/[[...path]]/route.ts`; internal studio route).
- Local output paths do not include the org scope even when passed; the extra org path is applied only to S3. Local stale files are reported, not deleted (`copilot/agent/lib/origin.ts` `pushOutput`, `staleOutputs`).
- Expiry cleanup swallows object-deletion failures and marks rows expired anyway. Metadata/extracted text and Eve-staged files are not purged by that job; 30 days is not a proven whole-conversation erasure guarantee (`web/lib/uploads.ts` `expireUploads`; `copilot/agent/lib/uploads.ts`).

## Mismatches

- Shared normal assignment helpers follow People account/member/assignment ordering except grants commit before missing members; post-grant DB failure can violate the learner-ledger check. Role/disable races and operator bypasses remain in [Organizations and roles — Mismatches](orgs-and-roles.md#mismatches) (`web/lib/org-people.ts:128–159`). Email startup fallback is allowed by People rule 12 and keeps the original event keys (`web/lib/queue-emails.ts` `queueEmails`).

- `PRODUCT.md` describes an evolving blueprint, Agent/Domain YAML drafts, Pipecat/deterministic publishing and recoverable drafts. Today's UI and tools build twin/role-play skill packages; there is no blueprint or draft read/save tool in this copilot (`web/components/copilot-chat.tsx`; `copilot/agent/tools/`; `web/lib/scenario-ingest.ts`).
- `PRODUCT.md` says no unrestricted shell/filesystem access. The app exports Eve's `bash`, `glob`, `grep` and `read_file`; only `write` is path-scoped. Instructions say bash is read-only, but `bash.ts` is an unwrapped tool export, not a read-only command validator (`copilot/agent/tools/bash.ts`, `glob.ts`, `grep.ts`, `read_file.ts`, `write.ts`; `copilot/agent/sandbox.ts`).
- The earlier phase-1 plan names Bearer `COPILOT_SERVICE_SECRET`, `updateAccess` and `shareLink`, with invitation approval. The final plan decisions narrow this to invite-only learners without approval; code follows that narrower scope and uses **`SCENARIO_INGEST_SECRET`** on the internal studio route. `COPILOT_SERVICE_SECRET` remains the web→Eve Basic secret (`plans/copilot-v2.md`; both service routes; `web/lib/copilot-studio.ts`).
- Phase 0 proposes removing `copilot-handoff.ts`; it remains and has current seed consumers/producers, not merely old draft state (`web/lib/copilot-handoff.ts`; `web/components/copilot-chat.tsx`; `web/components/twin/twin-agents-page.tsx`).
- The plan's initial “no upload from composer yet” decision has been overtaken: the current composer uploads temporary images/PDFs. Its Files picker still selects persistent KB items only (`plans/copilot-v2.md`; `web/components/copilot-composer.tsx`; `web/components/copilot-chat.tsx` `send`).
- Phase 2 proposes incremental merge mode for both products. It exists for twin skills; recordings-based role plays load reference files and rebuild instead (`copilot/agent/tools/load_skill.ts`, `build_scenario.ts`; `copilot/agent/lib/twin-skill.ts`).
- The plan proposes soft-deleting knowledge documents and hiding deleted items from the picker. Current copilot queries filter failed status, not a knowledge deleted timestamp (`web/lib/copilot-studio.ts` `listKnowledge`; `web/app/api/internal/knowledge-sources/route.ts`; `web/components/copilot-composer.tsx`). See [Knowledge](knowledge.md) for deletion behavior.

## Open questions

- Should “kept for 30 days” mean erasing extracted text/chunks and already-staged conversation files too? Instructions promise 30-day attachments; `expireUploads` removes objects and clears legacy bytes, but retains extracted text/chunks and does not contact Eve (`copilot/agent/instructions/copilot.md`; `web/lib/uploads.ts`; `copilot/agent/lib/uploads.ts`).
- Should a missing baseline artifact stop an update instead of silently supplying empty items/fallback manifest? `getSkill` tolerates download errors, while `load_skill` treats that answer as the update baseline (`web/lib/copilot-studio.ts` `getSkill`; `copilot/agent/tools/load_skill.ts`).
- Is approval solely at the agent boundary sufficient for all privileged callers? Tools require approval, but the service-secret internal route has no approval proof and ingestion routes require only secret + org, not the enabled acting member check used by studio actions (`copilot/agent/tools/publish.ts`, `update_twin.ts`; `web/app/api/internal/copilot-studio/route.ts`; `web/app/api/internal/scenarios/route.ts`, `twin-skills/route.ts`).

## Tests today

| Layer | Existing coverage |
| --- | --- |
| Copilot local sandbox | `copilot/test/sandbox.node.mjs`: JustBash search line numbers, empty hits and loud command failure. |
| Copilot unit | `copilot/test/copilot-v2.test.ts`: merge/dedup/removal, fixed skill ID, exact edits, post-publish rebase, trusted org/user headers, cross-org refusal, output scope and mid-chat source re-sync. |
| Web unit | `web/tests/lib/copilot-message.test.ts`: tag round-trip/escaping, plain text, unknown skill, slash filtering. `web/tests/lib/copilot-studio.test.ts`: learner-only invites, ignored minutes, module-kind separation, archive/restore/main-twin refusal, old/current artifacts (injected fake dependencies). |
| Ingestion unit/contracts | `web/tests/lib/scenario-ingest.test.ts`, `scenario-ingest-contract.test.ts`: real publisher→web contracts with fake DB/S3/Chroma, secret/org validation, knowledge loading/failures, source/privacy checks, versioning, archive republish and failed-write safety. |
| Shared upload tests | `web/tests/lib/context-upload.test.ts`: shared Before/upload settings. `web/tests/lib/during-upload.test.ts`: permitted types/limits. `web/tests/api/upload.test.ts`: shared multipart upload route, not the whole copilot S3 conversation flow. |
| DB, flow, browser, Python | No dedicated copilot DB, `web/tests/flows`, `web/e2e`, `agent/tests` or `chat/tests` coverage identified for this module. |

Important uncovered behavior: end-to-end proxy ownership/role disabling, internal action membership checks, approval rejection and duplicate clicks, actual provider/sandbox isolation, copilot presign→complete→resolve→expiry (including retained text), baseline download failure, and real browser recovery from stranded sessions. The existing fake-backed tests do not prove deployed secret wiring or whole-file erasure.
