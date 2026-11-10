# Sessions

> A session is one practice conversation, not the user's sign-in session. This module starts the conversation, connects the browser to LiveKit, saves its ending and evidence, records time used, and starts the right report. It also exposes the session-bound runtime and workspace routes. The main owners are `web/lib/interview-sessions.ts`, `web/lib/session-activation.ts`, and `web/lib/session-lifecycle.ts`.

## Who uses it

- **Learner:** starts or resumes their own voice practice, attaches allowed documents, ends the call, and leaves feedback. Routes resolve the signed-in user and organization through `web/lib/session-user.ts` `resolveSessionUser`; ownership checks live in `web/app/api/sessions/*`.
- **Org admin and team:** try agents without learner metering, list org sessions, and read learners' snapshots and recordings. See [Organizations and roles](orgs-and-roles.md). Pointers: `web/lib/interview-sessions.ts` `activateSession`, `web/app/api/sessions/route.ts` GET, `web/app/api/sessions/[id]/route.ts` GET.
- **Voice agent and session browser:** use a session-scoped runtime token for runtime, command, UI-state, and recording-upload routes. The voice agent uses a separate shared service secret for the completion webhook. Pointers: `web/lib/interview-sessions.ts` `authorizeRuntimeSession`, `web/app/api/sessions/webhook/route.ts` `authorized`.
- **API integrator:** reads role-play session results through the public API; this is not the runtime-token API. See [Public API](public-api.md); `web/app/api/v1/sessions/route.ts`.

## Words used here

| Term | Meaning and source |
| --- | --- |
| Session | `InterviewSession`: one run by a user in an org (`web/prisma/schema.prisma`). |
| Deployment | An agent's launch configuration, including allowed delivery modes. Assignments point to it (`web/lib/interview-sessions.ts` `activateSession`). See [Role plays](roleplays.md). |
| Assignment | Access to practice, not the call itself. `assignmentId` is for role plays; `twinAssignmentId` is for twins (`web/prisma/schema.prisma`). See [Twins](twins.md) and [Role plays](roleplays.md). |
| Activation | Creating or resuming a session and connecting its runtimes (`web/lib/session-activation.ts` `startSessionNow`). |
| Activation key | Unique `activationKey` used to find an earlier start; different from the session's unique `shareCode` (`web/lib/interview-sessions.ts` `activateSession`). |
| Runtime token | Session credential derived from its ID and the service secret; only its SHA-256 hash is stored (`web/lib/interview-sessions.ts` `runtimeToken`, `authorizeRuntimeSession`). |
| Metered call | A call with `allowedSeconds`, taken from the learner's balance at start. Billed admin/team voice calls use the org balance as allowance; unbilled voice and staff chat are unmetered (`web/lib/interview-sessions.ts` `activateSession`). |
| Room / dispatch / egress | LiveKit conversation space / request to run the named voice agent / recording job that writes media to S3 (`web/lib/livekit.ts`). |
| Snapshot | `compiledSnapshot`: configuration and document manifests pinned for the call (`web/lib/interview-sessions.ts` `activateSession`). |
| Evidence | JSON saved beside the transcript: coverage, media keys, metrics, recording start, and final-transcript marker (`web/lib/interview-sessions.ts` `mergeSessionEvidence`, `web/app/api/sessions/webhook/route.ts`). |
| `holdOpening` | Browser start option, sent as `hold_opening` metadata, that delays the greeting until `begin-opening` (`web/lib/session-activation.ts`, `agent/src/agent.py`). |
| After-call report | Processing chosen by `Agent.data.after.report`; not the same as Next.js `after()`, which runs background work after a response (`web/lib/session-after.ts`, `web/lib/session-close.ts`). |
| Command / UI state | A pending browser workspace action / the browser's current visible surface (`web/lib/workspace-commands.ts`, `web/app/api/sessions/[id]/ui-state/route.ts`). |

## Data

### Session record

`web/prisma/schema.prisma` `InterviewSession` owns these fields. Statuses are strings, not a Prisma enum.

| Fields | Meaning / writer |
| --- | --- |
| `id`, `orgId`, `userId`, `agentId` | Call identity, org and owner; activation writes them. |
| `shareCode`, `activationKey` | Unique call code and nullable unique activation key; activation writes them. |
| `deploymentId`, `assignmentId`, `twinAssignmentId`, `mode` | Launch/access links; `mode` defaults to `voice`, also supports `chat`. |
| `personaSlug`, `personaVersion`, `agentSlug`, `agentVersion`, `compiledSnapshot` | Start-time configuration references and compiled data; activation writes them. |
| `contextId`, `contextName` | Legacy primary document; additional documents use the join table. |
| `status`, `createdAt`, `startedAt`, `endedAt`, `deletedAt`, `attempt` | Lifecycle, soft deletion and attempt metadata; `attempt` defaults to 1. Normal activation creates a new row, not an incremented attempt. |
| `runtimeTokenHash`, `runtimeState`, `runtimeRevision`, `lastCompletion`, `warmOpening` | Runtime authorization, progress, latest completion replay, and best-effort opening preparation. |
| `allowedSeconds` | Nullable start-time learner allowance; usage is capped at it. |
| `livekitRoom`, `livekitDispatchId`, `videoEgressId`, `audioEgressId` | Transport/recording references. Current web activation writes room, dispatch and video egress, not audio egress. |
| `transcript`, `evidence`, `s3AudioKey` | Conversation lines, accumulated evidence, and dedicated audio location. |
| `report`, `reportStatus`, `reportWorkflowRunId` | Stored report JSON, processing status, and durable workflow ID where used. |
| `feedbackRating`, `feedbackNote` | Owner's latest rating and note. |

Writers: `web/lib/interview-sessions.ts`, `web/lib/session-activation.ts`, `web/lib/runtime/openai.ts`, `web/lib/session-warm.ts`, `web/app/api/sessions/webhook/route.ts`, `web/app/api/sessions/recording/route.ts`, and the report/feedback owners below.

`InterviewSessionDocument` has composite key `(sessionId, documentId)` and a creation time. Activation and the documents route add links; deleting either parent cascades links. `WorkspaceCommand` has globally unique `id` (the tool call ID), `sessionId`, `tool`, `input`, `status`, `result`, and completion timestamps. Its lifecycle is `pending → completed | failed`. Pointers: `web/prisma/schema.prisma`, `web/lib/workspace-commands.ts`.

A session cannot have both assignment kinds (`session_one_assignment_kind`); twin sessions must be voice. DB access checks are also enforced by triggers in `web/prisma/migrations/20261027020000_twin_access/migration.sql`.

### Lifecycles

| State / transition | What actually writes or accepts it |
| --- | --- |
| `assigned` | Schema default and legacy `createAssignedSession`; ordinary activation creates a separate `activating` row. The legacy helper is retained for local scripts, not assignment starts (`web/lib/interview-sessions.ts`). |
| new → `activating` → `active` | Create snapshot/state, initialize chat, then stamp `startedAt` and token hash (`activateSession`). |
| `activating` / `active` → `failed` | Chat initialization or later LiveKit activation failure (`activateSession`, `web/lib/session-activation.ts`). |
| → `completed` / `abandoned` | Shared finalizer on explicit ending; `completed` cannot be downgraded. `abandoned` can later become `completed` (`finalizeSessionRow`, `resolveSessionEndStatus`). |
| `closing` | Accepted by runtime authorization, but these lifecycle functions do not set it (`authorizeRuntimeSession`). |
| `assigned` → `revoked` | Member disabling; open `activating`/`active` calls instead close as `abandoned` (`web/lib/members.ts` `setMemberDisabled`). |
| failed row → deleted → new activation | A retry with the same activation key deletes the failed row first (`activateSession`). |

Report lifecycle is independent: `none`/null/`failed → generating → completed | failed`. A failed report does not make the call status `failed`. Pointers: `web/lib/session-close.ts`, `web/workflows/steps/session-end.ts`, `web/lib/report-model.ts`.

## How it works

### 1. Activate or resume

1. `POST /api/sessions` resolves user and org. It requires `shareCode`, `agentSlug`, or `deploymentKey`. Without a share code, membership is required; a slug-only start also requires admin/team. Only literal `mode: "chat"` selects chat; all other values select voice. Pointers: `web/app/api/sessions/route.ts` POST, `web/lib/session-user.ts`.
2. `activateSession` rejects disabled membership. Role-play codes must match required member.userId to the signed-in account, have status `pending` or `used`, and point to an active deployment allowing the mode. It does not check `expiresAt`. Non-role-play codes go through twin access with `join: false`, never creating members or assignments. An active common-code page has already joined the learner before prejoin; a nonmember direct common-code start is refused. Direct twin starts use twin access unless the user is admin/team. See [Twins](twins.md) and [Role plays](roleplays.md) for access ownership (`web/lib/interview-sessions.ts` `activateSession`).
3. It chooses the activation key:
   - Role-play assignment: reuse the latest `activating`/`active` call's key for this assignment and user; otherwise `assignment:<assignmentId>:<random>`. The supplied idempotency key is not used here.
   - Twin code: `twin:<assignmentId>:<idempotencyKey>` when supplied, otherwise `direct:<random>`.
   - Direct deployment/agent: `deployment:<deploymentId>:<idempotencyKey>` when supplied, otherwise `direct:<random>`.
   Pointer: `web/lib/interview-sessions.ts` `activateSession`.
4. A matching live row resumes: derive the same runtime token, refresh its hash, and return its original mode/status. Remaining seconds are `max(0, allowedSeconds - floor(elapsed seconds))`, measured from `startedAt`, falling back to `createdAt`. A failed matching row is deleted; another ended matching row returns null. Role-play links normally get a new key after ending, so they support repeat practice (`activateSession`).
5. Every non-admin/team caller is metered, including a common-link learner already joined by page opening. Twins and all metered calls reject chat with 400. For a **new** metered call, close every other `activating`/`active` call by this user in this org as abandoned, record its time, then read the balance. Below `MIN_START_MINUTES` (5 minutes / 300 seconds) fails with 403 and `code: "minutes"`. Zero or negative uses `OUT_OF_MINUTES`; positive balances say “You need at least 5 minutes to start a call; you have N. Ask your trainer for more.” Billed admin/team voice calls similarly require 300 org seconds; nonpositive uses `ORG_OUT_OF_CREDITS`, otherwise the refusal says the organization needs at least 5 credits and has N. Resume returns before this new-call check (`activateSession`, `web/app/api/sessions/route.ts`). See [Credits](credits.md).
6. Load an unarchived agent and ready same-org documents. Reject another user's owned document, missing documents, or files outside the before-call PDF/image limit of 10 MB. For agents using before settings, supplied files also require `preUpload`. Missing membership is refused here; role-play assignments already have members and common-link learners joined when the page opened. Activation creates no member. Compile configuration, pin all-skills twin skill versions, create the `activating` row and document links (`sessionSnapshot`, `activateSession` in `web/lib/interview-sessions.ts`). Upload storage belongs to [Platform](platform.md).
7. Initialize the chat service even for voice: `POST <CHAT_URL>/internal/sessions` (default `http://localhost:2000`), shared-secret bearer auth, `x-trainertwin-org-id`, body `{ sessionId, mode, contextVersion: 1 }`. A non-OK response fails activation. Success transactionally sets the call active with start time/token hash and marks a role-play assignment used (`initializeChatSession`, `activateSession`).
8. The route runs `runSessionStart`: start the `startSession` workflow and await `run.returnValue` (poll interval defaults to 100 ms). Only failure to start falls back to `startSessionNow`, not a later workflow failure. `open` calls `openSession`; voice then runs `connect`/`connectVoice`, while chat returns the runtime token as `conversationToken`. Both steps have `maxRetries = 0` to avoid duplicate dispatches. Known access/minutes/document refusals return `{ok:false,status,error,code?}`; null activation is a 403 invalid-link refusal, unknown errors propagate. The route returns refusal status with `{error,code?}`, or `{session,participantToken?,room?,conversationToken?}` (undefined keys omitted); unexpected errors become a generic 500. After success only, the route schedules best-effort `warmChatOpening` with `after()`. Owners: `web/lib/run-session-start.ts`, `web/lib/session-activation.ts`, `web/workflows/start-session.ts`, `web/workflows/steps/start-session.ts`.

### 2. Connect LiveKit and release the greeting

1. Resolve a ready voice: explicit agent voice first, otherwise persona voice; accept only same-org/global voices. If unavailable, try the alphabetically first ready global voice (`web/lib/session-activation.ts` `connectVoice`). See [Personas and voice](personas-and-voice.md).
2. Room name is the session ID. Create it with empty timeout 600 seconds and departure timeout 30 seconds, or update existing room metadata. Reuse a dispatch for the configured agent name, otherwise create one. Metadata contains `sessionId`, `orgId`, `agentSlug`, runtime token, `hold_opening`, optional voice, absolute `ends_at`, and agent kind (`web/lib/livekit.ts` `activateLiveKitSession`).
3. When a bucket exists, reuse an egress in status 0/1/2 or try a room-composite MP4 recording, H264 1080p30, mixed audio plus screen/speaker tiles. Key: `<S3_BASE_PREFIX>/<orgId>/recordings/<sessionId>/video.mp4`; prefix defaults to `trainertwin-dev`. Egress failure only warns. The expected key can be saved even when egress did not start (`web/lib/livekit.ts`).
4. Store room, dispatch, egress ID and video key. Return participant JWT and room. JWT identity is `user-<userId>` and grants room join, publish, subscribe and data publishing (`web/lib/session-activation.ts`, `web/lib/livekit.ts`).
5. Hold the greeting if the agent has an intro video or the caller requests it. `SessionView` starts with `holdOpening: true`; after launch, connection, agent arrival and any intro, it applies mic/camera choices and sends reliable `{ type: "begin-opening" }`. The Python agent buffers typed input and gates audio while held, with a 60-second release timeout. This is not an unbounded pause (`web/components/session-view.tsx`, `agent/src/agent.py` `TrainerAgent`, `OPENING_RELEASE_TIMEOUT`). Runtime behavior belongs to [Voice agent and chat](voice-agent-and-chat.md).

### 3. End the call and save transcript/evidence

- A refused/failed browser start keeps `startedRef` set throughout the five-second get-ready countdown: no repeated POST each tick. Only explicit “Try again” resets it (`web/components/session-view.tsx`).
- The browser derives a deadline from `launch.session.secondsLeft`. A non-manual end at or after 30 seconds before that deadline is `time_up`, finalized as completed. The end card says “Time's up” with learner/trainer or org-credit guidance; learner feedback includes the time-up explanation above the form. Manual endings remain manual even near the deadline (`SessionView` `handleDisconnect`, `TIME_UP_MARGIN_MS`).

- closeInterviewSession saves the end first through finalizeInterviewSession (status, transcript/evidence, first end time and inline usage charge). Only a changed status calls startSessionEnd; it chooses end-twin-session for TWIN, end-roleplay-session otherwise. Thus failed room closure cannot stop transcript persistence. The workflow closes LiveKit strictly, charges again safely, then claims/generates a report. Workflow startup failure attempts strict close and charge inline, catches/logs each failure and generates no report (`web/lib/session-lifecycle.ts`; `web/lib/session-end.ts`; `web/lib/session-close.ts`; `web/lib/interview-sessions.ts` `finalizeInterviewSession`).
- Browser finalization requires the owning user in the same org and status `completed` or `abandoned`. It accepts nonempty transcript arrays, keeping object entries with string `text`; evidence must be a nonempty object. `SessionView` uses keepalive, checks HTTP success, and keeps a visible save/retry error rather than silently ending on failure (`web/app/api/sessions/finalize/route.ts`, `web/components/session-view.tsx` `finalizeSession`, `handleDisconnect`).
- Finalization keeps the first `endedAt`, clears the token hash, and never downgrades completed. Otherwise it does not restrict the previous status. A linked pending role-play assignment becomes used on completed/abandoned. Evidence is a shallow merge; incoming keys replace matching old keys (`web/lib/interview-sessions.ts` `finalizeSessionRow`, `mergeSessionEvidence`).
- Normally the first nonempty transcript wins. For report kinds other than legacy `session`, the authenticated agent webhook may replace it with a nonempty full transcript and marks `evidence.transcriptFinal = true`; this includes twin calibrations. Empty incoming transcripts never clear an existing one (`web/lib/session-after.ts` `usesAgentTranscript`, `web/app/api/sessions/webhook/route.ts`, `web/lib/interview-sessions.ts`).
- Agent transcript lines are `{ role: "user" | "trainer", text, spokenAt? }`, where `spokenAt` is epoch milliseconds. They come from voice-session history at shutdown. Report readers classify `role: "user"` or `speaker: "learner"` as learner; other roles are treated as the AI. `transcriptTurns` joins adjacent learner pieces except “Feels off” messages (`agent/src/agent.py` `on_session_end`, `web/lib/twin/stats.ts`, `web/lib/generate-session-report.ts`).
- Browser finalize also best-effort creates the learner memory collection and asynchronously saves learner lines with key `session_<id>`. Memory/report errors are logged, not returned as save failure. Browser finalize, runtime-token PATCH and recognized-status agent webhook all call closeInterviewSession; no separate processEndedSession dispatcher remains (`web/app/api/sessions/finalize/route.ts`, `web/app/api/sessions/route.ts` PATCH, `web/app/api/sessions/webhook/route.ts`). See [Knowledge](knowledge.md) for memory storage.

### 4. Agent completion webhook

`POST /api/sessions/webhook` is service-secret authenticated, not cookie or runtime-token authenticated. It compares bearer bytes with `COPILOT_SERVICE_SECRET` using equal length and constant-time comparison **before parsing JSON or querying the DB**. Missing secret or credentials returns 401 (`web/app/api/sessions/webhook/route.ts` `authorized`).

| Payload | Accepted behavior (`payloadSchema`, POST in that route) |
| --- | --- |
| `session_id`, `sessionId`, `room_name` | Nullable strings, max 200 each; first truthy value wins, then trim and remove leading `session-`. Find by ID or session share code. Missing identifier: 400; no matching row: 404. |
| `status` | Nullable string, max 40. `COMPLETED → completed`; `FAILED`/`ABANDONED → abandoned`. Other strings or omission perform an evidence/transcript-only update, not a status transition. |
| `transcript` | Nullable array, max 10,000 lines. Each has string `role` ≤40, string `text` ≤50,000, optional nullable nonnegative numeric `spokenAt`; extra line fields are allowed. |
| `report`, `metrics` | Nullable record / optional arbitrary value. `report` fields merge into evidence, not the generated `report` column. Truthy metrics are stored in evidence. |
| `video_url`, `video_s3_key`, `audio_url`, `audio_s3_key`, `participant_identity` | Nullable strings ≤2,000. Media values become evidence fields; participant identity is accepted but not persisted here. |

Malformed JSON/schema returns 400 (up to five validation issues). The handler tries to obtain recording start time from LiveKit egress, ignoring lookup failure. It saves that as epoch milliseconds for report timing. A recognized end status closes the room and finalizes; an unrecognized status calls the finalizer without ending. Same-status endings only enrich saved data and do not start another workflow; abandoned → completed does. No-status webhook never starts an end workflow. Startup failure logs and falls back to close/charge without report; successful webhook response is `{ ok: true, sessionId, status }` (`web/app/api/sessions/webhook/route.ts`, `web/lib/livekit.ts` `recordingStartedAt`).

The producer sends bearer service auth, refuses to send without a configured secret, uses a 15-second request timeout, and retries once after two seconds **only for HTTP 5xx**, not general connection errors or 4xx. Errors are logged rather than propagated (`agent/src/recording/webhook.py` `post_completion_webhook`).

### 5. Usage and recordings

- An end-status finalization records usage after the DB transaction. Usage is whole elapsed seconds, floored, clamped to zero and `allowedSeconds`. Missing allowance/start/end or status failed/revoked gives zero. One unique ledger entry per session prevents duplicate charges; only duplicate-key errors are ignored. Transcript-only updates do not charge (`web/lib/interview-sessions.ts` `finalizeInterviewSession`, `web/lib/minutes.ts` `sessionUsageSeconds`, `recordSessionUsage`). Live calls also count toward balance before a ledger write; see [Credits](credits.md).
- Provider/model usage is separate from learner seconds. Web runtime meters one turn's accumulated usage by request hash; reports meter model generations; the voice agent flushes usage on shutdown. See [Platform](platform.md) and [Voice agent and chat](voice-agent-and-chat.md). Pointers: `web/lib/runtime/openai.ts`, `web/lib/report-model.ts`, `web/lib/generate-session-report.ts`, `agent/src/agent.py` `on_session_end`.
- Current web activation records composite video with audio. The Python `recording/egress.py` contains separate audio/video helpers, but current `agent/src/agent.py` does not call them. Do not assume every session gets a separate audio file (`web/lib/livekit.ts`, `agent/src/recording/egress.py`).
- `POST /api/sessions/recording?sessionId=...` accepts nonempty raw bytes under an authorized live runtime token. It requires S3 configuration, writes `audio/wav` at `<orgPrefix>/recordings/<sessionId>.wav`, and saves `s3AudioKey`. There is no WAV-content or size validation here (`web/app/api/sessions/recording/route.ts`, `web/lib/s3.ts` `recordingKey`).
- Playback routes allow the owner or admin/team in the same org and redirect to a one-hour S3 signed GET. Audio requires `s3AudioKey`; video uses evidence's `videoS3Key` or the expected composite key without checking that an object exists. These routes do not filter `deletedAt` (`web/app/api/sessions/[id]/audio/route.ts`, `web/app/api/sessions/[id]/video/route.ts`).

### 6. Generate and show reports

After the end is saved, startSessionEnd chooses the workflow by current Agent.kind. Both closeRoom (strict retries, exhausted errors ignored) → chargeCall → takeReport. closeLiveKitSession strict ignores 404/not_found/failed_precondition but propagates other failures; ordinary non-strict callers retain best-effort behavior (`web/lib/session-end.ts`; `web/lib/livekit.ts`; `web/workflows/end-twin-session.ts`; `web/workflows/end-roleplay-session.ts`; `web/workflows/steps/session-end.ts`).

reportFor reads current after.report through reportKindOf: explicit twin/roleplay, otherwise twin for TWIN or session for v1. Calibrations are excluded on the twin path. Completed twin calls qualify; abandoned twin calls qualify only when saved transcript already has learner speech. Roleplay/session require completed. claimReport atomically updates an ended row with null/none/failed report status to generating and sets reportWorkflowRunId to the current **end** run. A lost claim runs no report (`web/lib/session-close.ts` `reportFor`, `claimReport`; `web/lib/session-after.ts`; `web/workflows/steps/session-end.ts` `takeReport`).

| Report | Work and result |
| --- | --- |
| session (v1) | writeSessionReport invokes generateSessionReport inside end-roleplay-session, maxRetries=1, no transcript-final wait. Empty transcript fails; structured SessionReport and completed/failed state saved by helper. Gateway preferred, direct Gemini fallback without gateway credentials (`web/workflows/steps/session-end.ts`; `web/lib/generate-session-report.ts`). |
| twin | Summary, ≤4 topics, ≤5 questions/unanswered, generatedAt. No transcript is fatal; no learner lines gives an empty report without model call (`web/lib/twin/session-report.ts`). |
| roleplay | Snapshot brief/goals/rubric scoring, clamped points, key moments and focus. See [Role plays](roleplays.md) (`web/lib/roleplay/session-report.ts`). |

Twin/builder roleplay recheck readiness up to 12 times, sleeping 10 seconds each while no transcriptFinal. Skip marks failed; ready breaks the loop; timeout still generates from saved provisional text. Model generation and persistence are separate checkpointed steps; generation maxRetries=3; fatal errors stop, 429 retries respect bounded Retry-After, other retryable failures use workflow policy. Exhausted generation/save marks failed and rethrows (`web/workflows/end-{twin,roleplay}-session.ts`; `web/workflows/steps/{twin,roleplay}-session-report.ts`; `web/lib/report-model.ts`).

UI state is ready for a valid report, pending generating (or newly completed unclaimed for ten minutes), otherwise unavailable. Twin polling marks failed/cancelled workflow runs failed, but missing run IDs/lookups are not repaired. Roleplay polling reads row only. Details poll every three seconds, twin aggregates every five; background-tab intervals pause. No report email or recovery/restart loop (`web/lib/twin/trpc.ts` `sessionReportState`; `web/lib/twin/session-report.ts` `reportState`; `web/lib/roleplay/trpc.ts`; `web/components/twin/use-report-polling.ts`; `web/components/roleplay/roleplay-session-report-page.tsx`).

### 7. Documents, commands, UI state and web completions

- **Attach a document:** owner-cookie auth; call must be undeleted and activating/active. Use pinned before settings, falling back to current agent data; require `duringUpload`. Accept only ready same-org documents owned by this user, PDF ≤10 MB or image ≤5 MB. Add the join link idempotently and, if a snapshot exists, append document ID/manifest once. The next runtime turn can read the updated snapshot (`web/app/api/sessions/[id]/documents/route.ts`). File creation/expiry is [Platform](platform.md), not this route.
- **Run a command:** studio enqueues by tool call ID only for activating/active sessions in its org; upsert never changes an existing command. Browser polls pending commands oldest first and acknowledges result or failure using the runtime token. Only pending commands can be completed, so duplicate acknowledgments do not rewrite results. Enqueue waits up to 60 × 500 ms; other commands time out as pending, but `finish_session` closes as completed even on timeout. This close uses closeInterviewSession and therefore starts the end workflow on status change (`web/lib/workspace-commands.ts`, `web/app/api/sessions/[id]/commands/route.ts`, `web/app/api/sessions/[id]/commands/[callId]/route.ts`). Tool availability belongs to [Voice agent and chat](voice-agent-and-chat.md).
- **Report UI state:** runtime-token POST stores `{ active, key, updatedAt }` under `runtimeState.uiState`. Allowed surfaces are code, canvas, pdf, image, presentation; anything else becomes null. Key is truncated to 120 characters. Invalid/non-object body is 400. GET returns that state or null; it does not execute an action (`web/app/api/sessions/[id]/ui-state/route.ts`).
- **Web completions:** `POST /api/v1/chat/completions` delegates to `handleCompletions`. It uses a runtime bearer token, not an external API key; missing/invalid token gives OpenAI-shaped 401. Bad JSON gives 400. This is the web deterministic runtime adapter, separate from the chat-service initialization above (`web/app/api/v1/chat/completions/route.ts`, `web/lib/runtime/openai.ts`).
- The web adapter defaults `messages=[]`, `stream=true`, `tools=[]`; compiles the pinned snapshot (loads one if absent), updates runtime/evidence/transcript, and increments revision. It caches **only the latest** completion by normalized messages plus token hash/session ID. Repeating that hash returns cached JSON or SSE with `X-Idempotent-Replay: true`, without another grading pass. New responses expose `X-Execution-Count`; SSE ends with `[DONE]` and includes usage. This is buffered SSE, not token-by-token provider streaming (`web/lib/runtime/openai.ts` `runCompletionPipeline`, `computeRequestHash`, `buildSseStream`).
- Missing specs return 500. Pipeline exceptions become generic OpenAI-shaped 500, not raw exception details; individual direction/analysis/retrieval stages also have fallback paths. This error wrapper begins after authorization and JSON parsing (`web/lib/runtime/openai.ts` `handleCompletions`, `runDirectionCheck`, `runAnalyzerLLM`).

## Rules

1. Activation never creates an org member or twin assignment; twin codes use join=false and a nonmember direct common-code start is refused. Page opening owns common-link joining (`web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/twin-access.ts` `twinAccessByCode`). A disabled user cannot activate through any `activateSession` path. Billed admin/team voice calls require at least 5 org credits and set chargesOrg/allowedSeconds; staff chat and unbilled staff voice remain unmetered. Learners require at least 5 personal minutes for a new voice call (`web/lib/interview-sessions.ts` `activateSession`).
2. Twins and metered learners cannot start chat. A role-play assignment must also allow the requested mode (`activateSession`).
3. A role-play assignment in used status remains usable; a live call resumes, an ended call starts a new practice. Expiry timestamp alone is not an activation refusal (`activateSession`; `web/tests/lib/assigned-activation.test.ts`).
4. Resuming cannot reset `startedAt` or replenish `allowedSeconds`; it returns remaining time, even zero (`activateSession`).
5. A new metered call closes the user's other activating/active calls in the same org before reading its allowance. This is application sequencing, not a database one-live-call uniqueness constraint (`activateSession`, `web/prisma/schema.prisma`).
6. Runtime authorization accepts only hashes on activating/active/closing rows. Finalization clears the hash, so commands, completions and raw-recording upload cannot use it afterward (`authorizeRuntimeSession`, `finalizeSessionRow`).
7. Webhook auth runs before parsing and mutation; browser cookies and runtime tokens do not substitute for its service secret (`web/app/api/sessions/webhook/route.ts`).
8. Completed status is sticky, but transcript/evidence may still be enriched. First end time is retained; evidence merges shallowly (`web/lib/interview-sessions.ts` `finalizeSessionRow`).
9. Nonempty final agent transcripts replace browser transcripts only when `usesAgentTranscript` is true. Legacy session-report calls retain their first nonempty transcript (`web/lib/session-after.ts`, `web/app/api/sessions/webhook/route.ts`).
10. Usage is capped at the original allowance and written once per session; a report retry never debits practice seconds again (`web/lib/minutes.ts` `recordSessionUsage`; see [Credits](credits.md)).
11. End workflows atomically claim completed/abandoned rows with null/none/failed report status; generating/completed claims lose. Report eligibility narrows abandoned to twin learner speech; reportWorkflowRunId is the claiming end run (`web/lib/session-close.ts`; `web/workflows/steps/session-end.ts`).
12. Feedback is owner-only on completed/abandoned calls. Strict body: integer rating 1–5, required trimmed note ≤500 characters, no extra fields. Empty note stores null; repeat submission overwrites the two fields (`web/app/api/sessions/[id]/feedback/route.ts`).
13. Document attachment must pass both ownership and pinned permission checks; a hidden UI control alone is not authorization (`web/app/api/sessions/[id]/documents/route.ts`).
14. A command acknowledgment cannot change a completed/failed command; unknown/already-acknowledged IDs still get `{ ok: true }` from the route (`web/lib/workspace-commands.ts` `completeWorkspaceCommand`, acknowledgment route).

## Entry points

| Entry | Code |
| --- | --- |
| `GET /api/sessions` (studio list, latest 50 undeleted org calls); `POST` (activate); `PATCH` (runtime-token completed/abandoned) | `web/app/api/sessions/route.ts`; `web/lib/specs.ts` `listSessions` |
| `POST /api/sessions/finalize` (owner); `POST /api/sessions/webhook` (service) | `web/app/api/sessions/finalize/route.ts`, `web/app/api/sessions/webhook/route.ts` |
| `GET /api/sessions/:id` (owner/org studio or live token; status, coverage, phase index, revision) | `web/app/api/sessions/[id]/route.ts` |
| `POST /api/sessions/:id/feedback`; `POST /api/sessions/:id/documents` | `web/app/api/sessions/[id]/feedback/route.ts`, `web/app/api/sessions/[id]/documents/route.ts` |
| `GET /api/sessions/:id/commands`; `POST /api/sessions/:id/commands/:callId` | `web/app/api/sessions/[id]/commands/route.ts`, `web/app/api/sessions/[id]/commands/[callId]/route.ts` |
| `GET`, `POST /api/sessions/:id/ui-state` | `web/app/api/sessions/[id]/ui-state/route.ts` |
| `POST /api/sessions/recording?sessionId=...`; `GET /api/sessions/:id/audio`; `GET /api/sessions/:id/video` | `web/app/api/sessions/recording/route.ts`, `web/app/api/sessions/[id]/audio/route.ts`, `web/app/api/sessions/[id]/video/route.ts` |
| `POST /api/v1/chat/completions` | `web/app/api/v1/chat/completions/route.ts`, `web/lib/runtime/openai.ts` |
| Org-host `/s/:code`, `/t/:slug` practice pages | `web/app/(org)/s/[code]/page.tsx`, `web/app/(org)/t/[slug]/page.tsx`; see [Learner portal](learner-portal.md) |
| Studio `/talk`, `/agents/:slug/calibrate`, `/twin/:id/calibrate` | `web/app/dash/talk/page.tsx`, `web/app/dash/agents/[slug]/calibrate/page.tsx`, `web/app/dash/twin/[id]/calibrate/page.tsx` |
| Studio `/sessions`, `/sessions/:id`, `/twin/sessions`, `/twin/sessions/:id`, `/roleplay/sessions`, `/roleplay/sessions/:id` | Corresponding `web/app/dash/sessions`, `web/app/dash/twin/sessions`, `web/app/dash/roleplay/sessions` pages |
| Studio tRPC `sessions.get` / `sessions.reportState`; twin `agents.pendingReports` | `web/lib/twin/trpc.ts`, `web/lib/roleplay/trpc.ts` |
| End/report workflows | `web/lib/session-end.ts`, `web/lib/session-close.ts`, `web/workflows/end-twin-session.ts`, `web/workflows/end-roleplay-session.ts`; shared steps in `web/workflows/steps/session-end.ts`, report steps retained under `steps/*-session-report.ts` |
| Local legacy session helper | `web/lib/interview-sessions.ts` `createAssignedSession` |

No session-cleanup cron or session email sender is registered by these owners. Scheduled web crons are ingestion pumping and upload expiry (`web/vercel.json`); invitation email belongs to [Invites and emails](invites-and-emails.md).

## Talks to

| Boundary | What crosses it |
| --- | --- |
| Auth/org/access modules | Signed-in user/org, membership role, assignment/twin access decision; see [Auth](auth.md), [Organizations and roles](orgs-and-roles.md), [Twins](twins.md), [Role plays](roleplays.md). `web/lib/session-user.ts`, `web/lib/interview-sessions.ts`. |
| Chat service | Shared-secret initialization with session ID, mode and context version; session context is retrieved separately. `web/lib/interview-sessions.ts` `initializeChatSession`, `web/lib/session-context.ts`; see [Voice agent and chat](voice-agent-and-chat.md). |
| LiveKit / voice agent | Room/dispatch metadata, participant JWT, absolute learner deadline, greeting gate; completion transcript/media webhook comes back. `web/lib/livekit.ts`, `agent/src/agent.py`. |
| S3 / uploads | Composite recordings and raw WAV output; signed playback URLs; document IDs/manifests rather than uploaded bytes in activation. `web/lib/livekit.ts`, `web/lib/s3.ts`, documents route; see [Platform](platform.md). |
| Credits | Get balance after closing other learner calls; record capped end usage once. `web/lib/interview-sessions.ts`, `web/lib/minutes.ts`; see [Credits](credits.md). |
| Workflow / Next.js | One unchanged start-session workflow and two end workflows (strict close, idempotent charge, report); Next.js after only remains for opening warmup/memory. `web/lib/session-end.ts`, `web/lib/session-activation.ts`, `web/app/api/sessions/finalize/route.ts`. |
| LLM gateway / Gemini | Transcript and report criteria in, structured report out; provider usage recorded. `web/lib/report-model.ts`, `web/lib/generate-session-report.ts`, `web/lib/runtime/openai.ts`. |
| Learner memory | Learner lines from browser finalization; collection creation/save failures do not block save. `web/app/api/sessions/finalize/route.ts`; see [Knowledge](knowledge.md). |

## Edge cases and limits

- End row/inline charge and workflow startup are separate. Inline charge failure propagates before startSessionEnd despite the end row being saved; same-status retry does not start an end run. Startup fallback makes no report. An abandoned transition with no learner speech is ineligible; later same-status/no-status transcript enrichment cannot start its report. Late transcript after completed report does not regenerate it (`web/lib/interview-sessions.ts:61–65`; `web/lib/session-lifecycle.ts:22`; `web/lib/session-close.ts` `reportFor`; `web/app/api/sessions/webhook/route.ts`).

- **Activation failure:** chat-init failure leaves a failed row with end time and no token. LiveKit activation failure attempts cleanup using the previously read room references, marks the row failed unless already completed/abandoned, and reverts its role-play assignment from used to pending only if no other started nonfailed call exists. It rethrows; the HTTP route exposes only selected validation messages and otherwise a generic 500. Fresh room resources created before a failure may not yet be stored for cleanup (`web/lib/interview-sessions.ts`, `web/lib/session-activation.ts`, `web/app/api/sessions/route.ts`).
- **Initial document list:** `SessionView` sends both `contextId` and `contextIds`, but POST forwards only `contextId` and `startSessionNow` has no `contextIds` parameter. The helper `activateSession` supports multiple documents, but this browser activation path only passes the first (`web/components/session-view.tsx`, `web/app/api/sessions/route.ts`, `web/lib/session-activation.ts`, `web/lib/interview-sessions.ts`).
- **Missing service secret:** a new row is created before `runtimeToken()` is called, and that call is outside the chat-initialization catch. A missing secret can therefore leave an activating row instead of marking it failed (`web/lib/interview-sessions.ts` `activateSession`, `runtimeToken`).
- **Other active studio calls:** on a new activation without a role-play assignment, same-user/same-agent active rows are directly marked abandoned in the create transaction. Unlike metered-call cleanup, this does not close their rooms or call usage/report processing (`web/lib/interview-sessions.ts` `activateSession`).
- **Stale calls:** the voice agent watches for an empty room, checks every five seconds and grants roughly 30 seconds for reconnect before deleting the room and sending abandoned at shutdown. A learner deadline also deletes the room; normal shutdown defaults to completed. If the agent/webhook is lost, there is no web age-based sweeper here; a new learner start closes prior live rows, but resuming the same key does not age them out. Open calls still count capped time in balances (`agent/src/agent.py` `watch_empty_room`, `end_at_deadline`, `on_session_end`; `web/lib/interview-sessions.ts`; `web/lib/minutes.ts` `learnerMinutes`; `web/vercel.json`).
- **No report recovery loop:** generating with a missing run ID remains pending. Twin polling only repairs known failed/cancelled runs, not a null lookup or an age timeout; role-play polling does not inspect run status (`web/lib/twin/trpc.ts` `sessionReportState`, `web/lib/roleplay/trpc.ts`).
- **Latest-only replay:** completion caching and state revision writes are not concurrency locks. The adapter does not use revision compare-and-swap; simultaneous requests may race. UI-state writes likewise merge onto the row read at authorization (`web/lib/runtime/openai.ts` `runCompletionPipeline`, `web/app/api/sessions/[id]/ui-state/route.ts`).
- **Recording limits:** missing bucket disables web egress; egress failure does not fail activation. Playback signing is not proof a file exists. `web/lib/livekit.ts` prefers `AWS_S3_BUCKET`, while `web/lib/s3.ts` prefers `S3_BUCKET` if both are configured (`recordingOutput`, S3 module constants).
- **Existing shortcuts:** gateway-only workflow reports; exact normalized-text twin question aggregation; fixed English deadline goodbyes; 60-second greeting-hold cap. Their upgrade conditions live in `web/lib/report-model.ts`, `web/lib/twin/stats.ts` `mostAsked`, `agent/src/agent.py`.

## Mismatches

- The membership-check comment still says a common twin link added the member earlier in activation. The actual twin access call passes join=false; page opening is the join point (`web/lib/interview-sessions.ts:249,367–371` `activateSession`; `web/lib/pages/learner.ts` `loadSharedSession`).

- `PRODUCT.md` names Pipecat and the synthesizer deterministic runtime as the published voice path. Current web activation creates LiveKit dispatches and initializes the separate chat service; the voice agent uses LiveKit (`web/lib/session-activation.ts`, `web/lib/interview-sessions.ts`, `agent/src/agent.py`). The web deterministic adapter still exists separately in `web/lib/runtime/openai.ts`.
- Old plans describe separate twin/roleplay report workflows and best-effort v1 after() scheduling. Current two end workflows close, charge and claim all report kinds; v1 uses writeSessionReport with one retry (`web/lib/session-end.ts`; `web/workflows/end-roleplay-session.ts`; `web/workflows/steps/session-end.ts`).
- `plans/twin-wiring-and-reliability.md` says not to generate from a partial transcript after a bounded wait. Both current workflows fall through after 12 waits and generate from whatever was saved (`web/workflows/end-twin-session.ts`, `web/workflows/end-roleplay-session.ts`).
- That reliability plan asks for missing/stale workflow recovery and retryable enqueue errors returned to producers. Current end routes log report-start failure and return success; twin polling only handles explicit failed/cancelled run status (`web/app/api/sessions/webhook/route.ts`, `web/app/api/sessions/finalize/route.ts`, `web/app/api/sessions/route.ts` PATCH, `web/lib/twin/trpc.ts`).
- `plans/roleplay-skill.md` says access is “one attempt, 30 days.” Activation accepts used assignments and ignores expiry timestamps; repeat practice is limited by minutes. `web/tests/lib/assigned-activation.test.ts` explicitly covers resume past expiry (`web/lib/interview-sessions.ts`).
- The recording-upload route comment says Pipecat, but the current voice entrypoint is LiveKit and does not call the old audio/video egress helpers (`web/app/api/sessions/recording/route.ts`, `agent/src/agent.py`, `agent/src/recording/egress.py`).

## Open questions

1. **Should end-status webhooks populate dedicated audio playback?** The webhook constructs `s3AudioKey`, but passes it to `closeInterviewSession`, whose forwarding only includes transcript/evidence/replaceTranscript. A no-status webhook calls `finalizeInterviewSession` directly and can save it. Audio playback reads only the dedicated column, not evidence's `audioS3Key` (`web/app/api/sessions/webhook/route.ts`, `web/lib/session-lifecycle.ts`, `web/app/api/sessions/[id]/audio/route.ts`).
2. **What are the required idempotency and owner guarantees?** Direct deployment keys include deployment and caller-supplied idempotency key, not user ID. The existing-row lookup/resume does not check owner/org again, nor is lookup/create serialized. Should cross-user reuse and parallel-start conflicts be refused explicitly? (`web/lib/interview-sessions.ts` `activateSession`; unique `activationKey` in `web/prisma/schema.prisma`).
3. **Should late agent endings revive revoked/failed sessions?** `resolveSessionEndStatus` protects only completed; an authenticated webhook can move another previous status to completed/abandoned, retaining its first end time (`web/lib/interview-sessions.ts`, `web/app/api/sessions/webhook/route.ts`, `web/lib/members.ts`).
4. **Which report selection must remain pinned?** Dispatch and webhook transcript policy inspect current agent data, but role-play report input prefers pinned data. Editing `after.report` between start and end can therefore change routing or readiness expectations (`web/lib/session-close.ts`, `web/app/api/sessions/webhook/route.ts`, `web/lib/roleplay/session-report.ts`).
5. **Is a marker without transcript enough for final readiness?** For workflow report kinds, an authenticated webhook sets `transcriptFinal` even if it supplies no nonempty transcript. The workflow treats that marker as ready and may use the browser's transcript (`web/app/api/sessions/webhook/route.ts`, `web/workflows/steps/twin-session-report.ts`, `web/workflows/steps/roleplay-session-report.ts`).

## Tests today

Files below are existing coverage, not a claim that live services were exercised for this spec.

| Layer | Existing tests |
| --- | --- |
| Unit/helpers | `web/tests/lib/session-activation.test.ts` (refusal classification, direct chat/voice ordering, failed LiveKit cleanup); `start-session-workflow.test.ts` (zero retries, refusals, chat bypass, voice ordering); `run-session-start.test.ts` (await return value, startup-only fallback, polling default); `web/tests/lib/interview-sessions.test.ts` (sticky completed, first transcript, evidence merge); `assigned-activation.test.ts` (resume/remaining seconds and past expiry); `livekit.test.ts` (config); `minutes-livekit.test.ts` (deadline/kind metadata); `session-report-jobs.test.ts` (shared end steps, despite legacy test filename); `session-report.test.ts`, `session-report-grounding.test.ts` (report/timeline grounding); `twin-session-report.test.ts`, `roleplay-report.test.ts`, `twin-report-workflow.test.ts` (parsing, selection, claim/start failure and retry classification). |
| Web runtime | `web/tests/lib/runtime/runtime-check.test.ts`, `runtime-stream.test.ts`, `runtime-e2e.test.ts`, `document-retrieval-e2e.test.ts`, `spoken-first-prompting-e2e.test.ts`, `context-grounding.test.ts`, `knowledge-grounding.test.ts`, `claims.test.ts`. Some use real model/service configuration; these are not browser tests. |
| Route/component | `web/tests/api/session-start.test.ts` (refusal response/status, generic 500, credentials, post-response warmup); `web/tests/api/session-webhook.test.ts` (secret before lookup, malformed input, twin versus legacy transcript policy); `session-documents.test.ts` (attachment permissions/snapshot); `learner-session-access.test.ts` (owner/studio reads and feedback); `web/tests/components/session-control-bar.test.tsx` (controls). |
| DB | `web/tests/lib/minutes-sessions.db.test.ts` (metering, repeated usage, resume, replacing other calls, chat-init failure); `minutes-entrypoints.db.test.ts`, `minutes-stage-two-entrypoints.db.test.ts`, `minutes-learner-page.db.test.ts`; `web/tests/sql/assigned-learner-session.sql` (DB access constraints). DB suites are conditional on local test DB configuration. |
| Flows/browser | `web/tests/flows/credits-purchase-practice.flow.test.ts` includes activation and finalization across credit purchase; `web/e2e/learner.spec.ts` and `credits.spec.ts` cover portal/prejoin and out-of-credit behavior, including exactly one refused-start POST through the countdown and an explicit Try again retry, not a complete real recorded voice call. |
| Python/chat boundary | `agent/tests/test_session.py`, `test_minutes_limit.py`, `test_recording.py`; `chat/tests/agent/openai-compat.test.ts`, `lib/session-mode.test.ts`, `lib/session-plan.test.ts`, `lib/agent-tools.test.ts`. See [Voice agent and chat](voice-agent-and-chat.md) for runtime-owned detail. |

The existing component tests render static markup only, and browser fakes have no LiveKit signaling/room lifecycle. Deadline-based `time_up` classification, manual-end precedence and the feedback/card variants are therefore not automated here; verifying those still requires a live or browser-faked room.

Important gaps to test: concurrent/cross-user activation keys; resource leaks between dispatch and DB save; end-status audio-key forwarding; late learner transcript after an unreportable abandoned transition; empty final webhook readiness; stale/missing workflow recovery; late final transcript after a report already completed; runtime/UI-state concurrent writes; and a live LiveKit → S3 → webhook → report/playback run. These gaps follow the boundaries and open questions above, not new product requirements.

### Workflow source layout

`web/workflows/` has one workflow per file with header/caller, steps under `steps/`. `start-session.ts` remains one workflow. `end-twin-session.ts` / `end-roleplay-session.ts` replace the old report wrappers; report step files remain. `add-org-people`, `assign-twin`, `assign-roleplay`, `give-credits`, `send-emails`, `onboard-org`, `report-org-usage`, `sync-org-credits` are the other workflows. The deleted schedule-report/session-processing/session-report-jobs files are not callers anymore.

Current end coverage: `web/tests/lib/session-end.test.ts`, `session-end.db.test.ts`, `end-session-workflows.test.ts`, `session-report-jobs.test.ts`; missing-member starts `session-start-people.db.test.ts`. Not run for this spec update.
