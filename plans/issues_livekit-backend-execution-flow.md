# Issue 6: LiveKit Backend & Execution Flow Architecture

## 1. Context & Objectives
Establish a comprehensive, end-to-end specification of the LiveKit session lifecycle. 

This document defines two distinct layers:
1. **Layer 1: Canonical LiveKit Session Flow** — How standard LiveKit rooms, participant tokens, agent dispatches, and media pipelines work as designed by LiveKit.
2. **Layer 2: TrainerTwin System Implementation** — How our database records, invitation URLs, token issuance, runtime authorization, speech pipeline, egress recordings, and webhooks map onto the LiveKit layer.
3. **Synchronization & Concurrency Gates** — Explicitly identifies where execution **must be synchronous** to eliminate race conditions and avoid zombie calls or data corruption.

---

## 2. Layer 1: Canonical LiveKit Session Flow

```text
Host Backend                  LiveKit Cloud                   Client Browser                 Agent Worker
     │                              │                                │                             │
  1. ├─ Create Access Token ───────►│                                │                             │
     │  (roomJoin, roomConfig.agents)                                │                             │
     │                              │                                │                             │
  2. │◄─ Return Signed JWT ─────────┤                                │                             │
     │                              │                                │                             │
     │                              │  3. Connect(URL, Token)        │                             │
     │                              │◄───────────────────────────────┤                             │
     │                              ├─ Room Created (if new) ────────┤                             │
     │                              ├─ Local Audio Published ────────┤                             │
     │                              │                                │                             │
     │                              │  4. Dispatch Agent Job         │                             │
     │                              ├─────────────────────────────────────────────────────────────►│
     │                              │                                │   5. Connect(JobContext)    │
     │                              │◄─────────────────────────────────────────────────────────────┤
     │                              ├─ Agent Joins Room as 'AGENT' ──►                             │
     │                              ├─ Media Tracks Subscribed ──────┼─────────────────────────────┤
     │                              │                                │                             │
     │                              │  6. Active Speech & Data       │                             │
     │                              │◄══════════════════════════════►│◄═══════════════════════════►│
     │                              │                                │                             │
     │                              │  7. Disconnect / Leave         │                             │
     │                              │◄───────────────────────────────┤                             │
     │                              ├─ Room Closes / Disconnect Event├────────────────────────────►│
     │                              │                                │   8. Stop Egress & Webhook  │
     │◄─ Room Webhook (Finished) ───┤                                │                             │
```

### Flow Steps:
1. **Token Provisioning:** Backend issues a JWT signed with `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.
   - **Video Grants:** `roomJoin: true`, `roomCreate: true`, `canPublish: true`, `canSubscribe: true`, `canPublishData: true`.
   - **Room Configuration:** Encodes `RoomConfiguration.agents` with the target `agentName` (`intervoo-agent`) and JSON job metadata.
2. **Client Room Join:** Client connects via WebSocket (`wss://...`). If the room does not exist, the server creates it based on the token's `roomConfig`.
3. **Automated Agent Dispatch:** LiveKit Cloud detects the agent dispatch request attached to the room creation event and forwards a `JobRequest` to an active registered worker matching `agentName`.
4. **Agent Connection:** The worker accepts the job in `entrypoint(ctx: JobContext)`, extracts `ctx.job.metadata`, and calls `await ctx.connect()`. The agent joins the room as a remote participant with `kind=AGENT`.
5. **Bidirectional Interaction:**
   - Audio tracks are streamed over WebRTC peer connections.
   - Text transcriptions and workspace controls flow over Data Channels and LiveKit RPC methods.
6. **Room Teardown:**
   - When participants leave or the session is ended, `session.shutdown()` or `deleteRoom()` is invoked.
   - LiveKit finalizes any attached egress recordings, removes the room from the server, and fires webhook notifications.

---

## 3. Layer 2: TrainerTwin System Implementation Flow

The following diagram maps TrainerTwin's PostgreSQL database, Next.js web runtime, OpenRouter LLM orchestration, and S3 storage onto the LiveKit layer:

```text
PostgreSQL Neon            Web API (@web)           LiveKit Cloud           Client (/talk)           Python Agent
      │                          │                        │                        │                       │
      │ ── Step A: Initiation ── │                        │                        │                       │
      │◄─ Create InterviewSession┤                        │                        │                       │
      │   (status='assigned' or  │                        │                        │                       │
      │    'active', shareCode)  │                        │                        │                       │
      │                          │                        │                        │                       │
      │ ── Step B: Activation ── │                        │                        │                       │
      │◄─ Update InterviewSession│                        │                        │                       │
      │   (status='active',      │                        │                        │                       │
      │    runtimeTokenHash,     │                        │                        │                       │
      │    compiledSnapshot)     │                        │                        │                       │
      │                          ├─ Build AccessToken ───►│                        │                       │
      │                          │  (roomConfig.agents,   │                        │                       │
      │                          │   metadata)            │                        │                       │
      │                          │                        │                        │                       │
      │                          │ ── Step C: Client Join │                        │                       │
      │                          ├─ Return Token & Room ──────────────────────────►│                       │
      │                          │                        │  Connect LiveKitRoom   │                       │
      │                          │                        │◄───────────────────────┤                       │
      │                          │                        │                        │                       │
      │                          │ ── Step D: Agent Entry ├─ Dispatch Job ────────────────────────────────►│
      │                          │                        │                        │   Connect to Room     │
      │                          │                        │◄───────────────────────────────────────────────┤
      │                          │                        │   Start S3 Egress      │                       │
      │                          │                        │◄───────────────────────────────────────────────┤
      │                          │                        │                        │                       │
      │                          │ ── Step E: Conversational Loop (Runtime Auth)   │                       │
      │                          │◄─ POST /api/v1/chat/completions (Bearer token) ─────────────────────────┤
      │◄─ Validate Token Hash ───┤                                                                         │
      │   Load State & Probes    │                                                                         │
      │─► Update Evidence/State ─┤                                                                         │
      │                          ├─ Stream OpenAI SSE Chunks (Speech + Surface Tools) ────────────────────►│
      │                          │                                                 │   Spoken Audio (TTS)  │
      │                          │                        │◄───────────────────────────────────────────────┤
      │                          │                        │  Hear Agent Voice      │                       │
      │                          │                        ├───────────────────────►│                       │
      │                          │                        │                        │                       │
      │                          │ ── Step F: Termination & Webhook Finalization   │                       │
      │                          │                        │  Click 'End Session'   │                       │
      │                          │                        │  (AlertDialog Confirm) │                       │
      │                          │◄─ POST /api/sessions/finalize ──────────────────┤                       │
      │◄─ Update Session:        │   (transcript, evidence,                        │                       │
      │   status='completed',    │    runtimeTokenHash=NULL)                       │                       │
      │   endedAt=now()          │                                                 │                       │
      │                          │                        │                        │   Room Disconnected   │
      │                          │                        │◄───────────────────────────────────────────────┤
      │                          │                        │   Stop Egress          │                       │
      │                          │◄─ POST /api/sessions/webhook ───────────────────────────────────────────┤
      │◄─ Attach Audio/Video S3  │   (s3AudioKey, videoUrl)                                                │
      │   Keys to Session Record │                                                                         │
```

---

## 4. Step-by-Step Lifecycle Breakdown

### Step 1: Initiation & Allocation
- **Trigger:** Founder/Admin launches `/talk` or invites a learner via email (`/api/v1/assignments`).
- **Database Mutation:** Inserts an `InterviewSession` record:
  - `status: "assigned"` (or `"active"` for instant studio practice).
  - Generates unique `shareCode` (Base64URL).
  - Resolves `agentSlug`, `personaSlug`, `domainSlug`, and optional `contextId` (document attachment).
- **Communication (Optional):** Sends candidate invitation email containing `https://<org>.trainertwin.com/s/<shareCode>`.

### Step 2: Session Activation & Token Minting (`POST /api/sessions`)
- **Trigger:** Candidate arrives at `/talk` or `/session/[agent]` and clicks **"Start Session"**.
- **Execution (`web/lib/interview-sessions.ts`):**
  1. Resolves org and user membership.
  2. **Concurrency Invalidation (SYNC):** Marks any preexisting `active` sessions for this `(orgId, userId, agentId)` as `abandoned` and wipes their `runtimeTokenHash`.
  3. **Generates Runtime Secret:** Creates cryptographic `runtimeToken` (24 bytes Base64URL) and computes `runtimeTokenHash = sha256(runtimeToken)`.
  4. **Snapshots Scenario Specs:** Compiles agent rubrics, stages, probes, and hidden facts into `compiledSnapshot`. Initializes `runtimeState = { stage: 0, phase: 0, probes: 0 }`.
  5. **Atomically Updates DB:** Updates `InterviewSession` to `status: "active"`, sets `startedAt = new Date()`, saves `runtimeTokenHash` and snapshots.
  6. **Mints LiveKit Token:**
     - Room name: `session-${session.id}`.
     - Identity: `user-${user.id}`.
     - Grants: `roomJoin: true`, `roomCreate: true`, `canPublish: true`, `canSubscribe: true`, `canPublishData: true`.
     - `roomConfig.agents`: Injects `RoomAgentDispatch` targeting `intervoo-agent` with serialized metadata:
       ```json
       {
         "sessionId": "cmtx...",
         "runtimeToken": "rt-...",
         "orgId": "org-...",
         "agent_id": "lead-engineer",
         "webhook_url": "/api/sessions/webhook"
       }
       ```
  7. Returns `{ session: { id, runtimeToken }, livekit: { url, token, room } }`.

### Step 3: WebRTC Connect & Automated Agent Dispatch
- Client browser mounts `<LiveKitRoom>` and connects to LiveKit Cloud.
- LiveKit Cloud creates the room and triggers job dispatch to the connected Swarm worker on E2E Networks (`216.48.181.196`).
- **Agent Entrypoint (`agent/src/agent.py`):**
  1. Reads `ctx.job.metadata`.
  2. Extracts `sessionId`, `runtimeToken`, `orgId`, `webhook_url`.
  3. Connects to the room: `await ctx.connect()`.
  4. Starts S3 egress recording via LiveKit Egress API:
     - Output S3 bucket: `trainer-twin-prod`
     - S3 path: `{orgId}/recordings/{sessionId}.mp4`
  5. Initializes `TrainerAgent` with workspace tools (`workspace.code`, `workspace.canvas`, etc.).

### Step 4: Turn-Taking & Stateful Runtime Routing
- **Opening Turn:** Agent calls `{WEB_URL}/api/v1/chat/completions` with header `Authorization: Bearer <runtimeToken>` and prompt `"session-start"`.
- **Runtime Controller (`web/lib/runtime/openai.ts`):**
  1. Hashes incoming token: `sha256(token)` and queries Neon database for an active session with matching `runtimeTokenHash`.
  2. If found, hydrates `compiledSnapshot`, `runtimeState`, and prior `transcript`.
  3. Evaluates conversation progress, updates evidence/topic coverage.
  4. Selects action (e.g. `opening_question`, `deep_probe`, `challenge`).
  5. Generates speech conditioned on retrieved persona moments from Chroma.
  6. Emits OpenAI-compatible streaming chunks (`choices[0].delta.content`) and optional tool calls (`workspace.surface`).
  7. Updates `runtimeState`, `evidence`, and `lastCompletion` in database.
- **Agent Audio & UI:** Agent speaks the response via Sarvam TTS (`rohan`). Real-time speech transcription segments are sent to the client browser over the LiveKit data channel and displayed in `<SessionSidebar>`.

### Step 5: Termination, Disconnect & Finalization
- **Trigger:** User clicks **"End Session"** (confirmed via `AlertDialog`) or agent concludes interview.
- **Client Finalization Beacon (`POST /api/sessions/finalize`):**
  - Sends captured transcript turns and evidence coverage via `keepalive: fetch`.
  - Atomically updates `InterviewSession`:
    - `status = resolveSessionEndStatus(existing.status, requestedStatus)` (`"completed"` or `"abandoned"`).
    - Sets `endedAt = new Date()`.
    - **Invalidates Token (SYNC):** Sets `runtimeTokenHash = NULL`.
  - Tears down WebRTC connection (`room.disconnect()`).
- **Agent Teardown & Webhook (`agent/src/agent.py` `on_session_end`):**
  1. Agent stops S3 egress recording and waits for LiveKit Egress completion confirmation.
  2. Posts payload to `{WEB_URL}/api/sessions/webhook`:
     ```json
     {
       "session_id": "cmtx...",
       "room_name": "session-cmtx...",
       "audio_url": "https://trainer-twin-prod.s3.ap-south-1.amazonaws.com/trainertwin-dev/kb/{orgId}/recordings/{room}_{ts}/audio.mp4",
       "audio_s3_key": "trainertwin-dev/kb/{orgId}/recordings/{room}_{ts}/audio.mp4",
       "video_url": "...same dir.../video.mp4",
       "video_s3_key": "...same dir.../video.mp4",
       "status": "COMPLETED" | "ABANDONED",
       "participant_identity": "user-...",
       "transcript": [{"role": "user" | "trainer", "text": "..."}]
     }
     ```
     Actual S3 layout: `{S3_BASE_PREFIX}/{orgId}/recordings/{room_name}_{yyyymmdd_hhmmss}/audio.mp4` and `video.mp4` (two separate egresses). DB persists `s3AudioKey` (column) and `videoS3Key`/URLs inside the `evidence` JSON.
  3. Webhook handler merges recording keys + transcript into the session record and resolves status via `resolveSessionEndStatus` (never downgrades `completed` → `abandoned`). `ABANDONED` marks the session abandoned unless already completed.
  4. Agent calls `ctx.api.room.delete_room()` to gracefully destroy the LiveKit room.

### Zombie-Session Teardown (browser death without finalize)

With `close_on_disconnect=False` a killed tab leaves the job running forever:
no finalize, no webhook, and the session row stays `active` with a valid token.
A `watch_empty_room()` task in the agent entrypoint (started after `session.start`):

- Polls every 5s; if the room has no human participants for a continuous 30s
  (grace covers page refreshes/reconnects), sets `end_status = "ABANDONED"`
  in session state and calls `delete_room`.
- Deleting the room ends the job → `on_session_end` fires → egress stopped,
  webhook posted with status `ABANDONED` → DB marks `abandoned`.
- Intentional End Session is unaffected: finalize already marked `completed`,
  and the later `ABANDONED` webhook cannot downgrade it.

---

## 5. Synchronization & Concurrency Gates

To eliminate race conditions, the following operations have strict synchronization boundaries:

| Step | Operation | Execution Mode | Concurrency Guarantee & Rationale |
| :--- | :--- | :--- | :--- |
| **1** | **Prior Session Invalidation** | **SYNCHRONOUS (DB Transaction)** | Must mark old active sessions `abandoned` and wipe `runtimeTokenHash` *before* inserting a new session row. Guarantees only one active runtime token per user/agent. |
| **2** | **Session Record before LiveKit Token** | **SYNCHRONOUS** | The `InterviewSession` row with its hashed token *must be committed to PostgreSQL* before `createLiveKitSessionToken()` returns the JWT to the browser. Prevents a fast agent worker from receiving a 401 on its opening turn. |
| **3** | **LiveKit Room Join before Agent Turn** | **EVENT-DRIVEN (LiveKit Cloud)** | Using `roomConfig.agents` inside the token guarantees that LiveKit Cloud dispatches the worker *only when the participant establishes connection*. Prevents the agent from entering an empty room or crashing before the client arrives. |
| **4** | **Idempotency on `/chat/completions`** | **SYNCHRONOUS (In-Memory / Hash Check)** | If a network retry re-submits the exact same messages payload with the same token, the server returns the cached SSE response *without re-grading or spending probe budget*. |
| **5** | **Token Invalidation on Finalize** | **SYNCHRONOUS (DB Transaction)** | `runtimeTokenHash` is set to `NULL` inside `POST /api/sessions/finalize`. Immediately rejects any subsequent LLM inference calls if the agent process lags behind. |
| **6** | **Browser Finalize vs Egress Webhook Order** | **ASYNCHRONOUS / SAFE MERGE** | Either the browser beacon or the agent egress webhook can arrive first. `resolveSessionEndStatus()` guarantees that a later webhook or beacon never downgrades a `"completed"` session back to `"abandoned"`, and `COALESCE` protects canonical transcripts. |
| **7** | **Room Destruction** | **DEFERRED (Agent Teardown)** | `delete_room` must only execute *after* egress recording has stopped and the completion webhook has returned HTTP 200. Prevents cut-off recordings. |
| **8** | **Empty-Room Teardown** | **DEBOUNCED (30s grace)** | A room with zero human participants for 30 continuous seconds is torn down by the agent (`watch_empty_room`), covering tab death/refresh. Prevents zombie rooms, forever-`active` session rows, and runaway egress billing. |

---

## 6. Verification Checklist

Before certifying the LiveKit backend flow:
- [x] Starting `/talk` abandons preexisting active sessions in the database synchronously. (`ensureActiveSession` → `updateMany`)
- [x] Database record contains valid `runtimeTokenHash` before client connects to LiveKit. (token returned only after the update commits)
- [x] Client connect automatically summons `intervoo-agent` without manual API dispatch calls. (verified live 2026-09-11)
- [x] Agent successfully authenticates against `/api/v1/chat/completions` using dynamic bearer token. (fixed 2026-09-11: `InterviewSession.report`/`reportStatus`/`attempt` columns were missing from Neon — migration applied manually)
- [x] Clicking "End Session" confirms via dialog and triggers `/api/sessions/finalize`. (verified live)
- [x] Finalize beacon sets `runtimeTokenHash = NULL` and stamps `endedAt`. (verified in DB)
- [x] Subsequent calls to `/api/v1/chat/completions` with the old token strictly return HTTP 401. (mechanism verified; invalid-token probe returns structured 401)
- [x] Agent egress finishes and posts audio/video keys to `/api/sessions/webhook`. (verified live, webhook 200)
- [x] Database reflects updated S3 keys and completed status. (both 2026-09-11 sessions: `s3AudioKey` + `evidence.videoS3Key` set, status `completed`)
- [ ] Tab death without finalize marks the session `abandoned` within ~40s (watch_empty_room, deployed — needs one live verification).
- [ ] Persona speech validation loop latency (tracked separately in `plans/issues_persona-validation-loop.md`).
