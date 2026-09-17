# Scenario Deployment and Unified Session Runtime Plan

**Status:** Core runtime implemented on `feat/unified-session-runtime`; widget SDK and extra close-eval coverage still open
**Integration branch:** `feat/unified-session-runtime`  
**Baseline merge:** current `main` + `feat/agent-ui-state`  

## 1. Objective

Create one scenario deployment model and one autonomous conversation brain that works identically across chat and voice.

- `web/` owns deployments, assignments, session lifecycle, documents, durable product records, reports, and privileged infrastructure orchestration.
- `chat/` owns the durable conversation, prompting, tool registry, tool loop, retrieval decisions, and conversational state.
- `agent/` is a thin LiveKit voice adapter.
- LiveKit is used only for rooms, participants, STT, TTS, VAD/interruption, agent dispatch, and egress.
- Workspace commands and confirmed browser state use the durable session/event path, never LiveKit RPC.

Chat and voice are delivery modes for the same configured trainer, not separate agents.

## 2. Architectural principles

1. **One brain:** only `chat/` decides what the trainer says and which tools to call.
2. **Stable integration identity:** customers configure a deployment once; they do not rotate scenario API keys manually.
3. **Short-lived session capabilities remain internal:** participant and conversation credentials are minted automatically per active session.
4. **No eager media resources:** assignment and prejoin never create LiveKit rooms, tokens, dispatches, or egress.
5. **Activation is learner-triggered:** `/talk` or `/s/{shareCode}` triggers runtime creation only when the learner clicks Start.
6. **Version pinning happens at activation:** assignments follow the deployment; the resulting session snapshots the currently published versions.
7. **Durable screen truth:** the browser reports what is actually visible; the brain never infers workspace state from past commands.
8. **Idempotency:** repeated Start, reconnect, close, and infrastructure callbacks cannot duplicate sessions, rooms, dispatches, egress, or reports.
9. **The page triggers privileged operations but never performs them:** all LiveKit administration remains server-side.

## 3. System ownership

### 3.1 `web/` — control and persistence plane

Owns:

- Organizations and org-subdomain resolution.
- Scenarios, agents, personas, domains, and published versions.
- Stable deployments and integration keys.
- Role-play assignments and secure share links.
- One-file prejoin upload and document ownership.
- `InterviewSession` lifecycle and immutable activation snapshot.
- LiveKit activation orchestration.
- Durable transcript/event/report/recording persistence.
- Browser-confirmed `runtimeState.uiState` projection.
- Internal APIs used by `chat/` for context, retrieval, and lifecycle updates.

Does not own:

- Trainer reasoning.
- Prompt policy execution.
- The conversational tool loop.

### 3.2 `chat/` — durable conversation plane

Owns:

- Durable conversation session keyed by the `InterviewSession.id`.
- Conversation history and current conversational state.
- System instructions and per-session factual context.
- Agent/persona/domain behavior.
- Tool registration and execution loop.
- Knowledge, style, episodic, and document retrieval decisions.
- Workspace command creation and tool-result continuation.
- `finish_session` decision.
- Streaming trainer text for both chat and voice.

Calls authenticated `web/` APIs for:

- Session snapshot and learner identity.
- Attached documents and résumé claims.
- Approved knowledge.
- Persona style episodes.
- Learner history and episodic memory.
- Browser-confirmed UI state.
- Durable lifecycle/report events.

### 3.3 `agent/` — voice delivery adapter

Owns only:

- LiveKit room participation.
- STT and final transcript delivery to `chat/`.
- Streaming `chat/` responses into TTS.
- VAD, interruption, and cancellation propagation.
- Voice connection lifecycle.

Must not own:

- A second system prompt.
- Agent/domain/persona policy.
- Business tool registration.
- Workspace state.
- Knowledge or document retrieval.
- Interview progression.

### 3.4 LiveKit — media and recording plane

Used for:

- Rooms and participants.
- Participant tokens.
- STT and TTS transport.
- VAD/interruption.
- Agent dispatch.
- Egress.

Not used for:

- Prompting.
- Domain tools.
- Durable conversation history.
- Workspace command/state synchronization.
- Product session authority.

## 4. Stable deployment identity and credentials

### 4.1 Deployment

A deployment is the stable integration target for one published trainer configuration.

```text
Deployment
├── id / stable key
├── orgId
├── scenario/agent reference
├── publication policy: latest published | pinned
├── allowed modes: chat | voice | both
├── allowed origins/domains
├── anonymous/authenticated policy
├── rate and budget policy
└── status: active | disabled
```

The deployment remains stable while published scenario versions evolve.

### 4.2 Key classes

- `tt_pub_*`: browser-safe deployment identifier; origin-restricted, rate-limited, and unable to access existing sessions.
- `tt_sk_*`: server-side integration secret for trusted customer backends.
- Assignment `shareCode`: single-assignment entry capability, scoped to an organization and recipient.
- Conversation/session credential: short-lived and minted automatically after activation.
- LiveKit participant token: short-lived and minted automatically for voice join/rejoin.

The customer configures the stable deployment key once. Session-token rotation is an SDK/platform responsibility, not an integration burden.

## 5. Data model responsibilities

### 5.1 `RolePlayAssignment`

Represents an invitation/entitlement, not an interview attempt.

```text
RolePlayAssignment
├── id
├── orgId
├── deploymentId
├── recipientEmail / userId
├── shareCode
├── expiresAt
├── status: pending | used | expired | cancelled
├── assignedByUserId
├── assignedAt
└── usedAt
```

Rules:

- Created when an email assignment is sent.
- Does not store agent/persona/domain versions.
- Does not create an `InterviewSession`.
- Does not create any `chat/` or LiveKit runtime resources.
- `cancelled` means an unused invitation was withdrawn.

### 5.2 `InterviewSession`

Represents an actual learner attempt.

Created only when the learner clicks Start.

```text
InterviewSession
├── id
├── orgId / userId / assignmentId
├── deploymentId
├── mode: chat | voice
├── status: activating | active | closing | completed | abandoned | failed
├── agent/persona/domain version snapshot
├── compiled configuration snapshot
├── attached document(s), currently exactly one prejoin file
├── runtimeState.uiState
├── transcript / evidence / usage
├── LiveKit room/dispatch/egress identifiers when voice
├── startedAt / endedAt
└── failure/closure metadata
```

The activation snapshot is immutable for the lifetime of the session.

### 5.3 Relationship

Keep both tables because an invitation and an attempt have different lifecycles.

- One assignment may create zero sessions.
- Initially enforce at most one successful session per assignment.
- Preserve the schema path for explicit retries or multiple attempts later.

## 6. Organization-scoped learner entry

Assignment emails use:

```text
https://{orgSlug}.trainertwin.com/s/{shareCode}
```

Example:

```text
https://acme.trainertwin.com/s/abc123
```

Validation:

1. Resolve organization from the hostname.
2. Resolve the share code.
3. Confirm the assignment belongs to the hostname organization.
4. Confirm recipient identity when required.
5. Confirm status is `pending` and the assignment has not expired.
6. Reject cross-org, used, cancelled, and expired links without leaking assignment details.

Custom domains can later resolve to the same organization boundary.

## 7. Prejoin learner experience

The learner sees only learner-facing information.

```text
┌─────────────────────────┬──────────────────────────┐
│ Learner name            │ Upload your document     │
│ Session/scenario name   │ click or drag-and-drop   │
│                         │ exactly one file          │
└─────────────────────────┴──────────────────────────┘

                  [ Start Session ]
```

Rules:

- Do not show agent/persona/domain/version terminology.
- Do not show past uploads.
- Exactly one file can be selected.
- Replacing the file replaces the current selection.
- Start remains disabled until required input is valid.
- Uploading a file does not activate a session or create LiveKit resources.
- The entry point or assignment determines the mode unless the product explicitly offers a mode selector.

## 8. Activation flow

The page initiates one idempotent server operation when the learner clicks Start.

Suggested entry point:

```http
POST /api/assignments/{shareCode}/start
```

Example input:

```json
{
  "documentId": "doc_123",
  "mode": "voice",
  "idempotencyKey": "assignment-or-client-generated-key"
}
```

### 8.1 Common activation

The server:

1. Revalidates hostname organization, assignment, recipient, expiry, and document ownership.
2. Resolves the deployment's current published agent/persona/domain configuration.
3. Creates an `InterviewSession` with status `activating`.
4. Pins the resolved versions and compiled configuration snapshot.
5. Attaches the selected document.
6. Initializes a durable `chat/` session using the same session ID.
7. Marks the `InterviewSession` active only after required runtime setup succeeds.
8. Marks the assignment `used` only after activation succeeds.

Canonical correlation identity:

```text
InterviewSession ID = chat durable-session ID = LiveKit room name = egress correlation key
```

### 8.2 Chat activation

After common activation:

1. Mint a browser conversation credential scoped to this session.
2. Return the session ID and credential.
3. The page connects to the durable `chat/` stream.

```json
{
  "sessionId": "session_123",
  "mode": "chat",
  "conversationToken": "session-scoped-token"
}
```

### 8.3 Voice activation

After common activation, the same server operation:

1. Ensures LiveKit room `session_123`.
2. Dispatches the thin voice worker with `orgId` and `sessionId`.
3. Starts egress immediately.
4. Mints the learner participant token.
5. Persists room, dispatch, and egress identifiers.
6. Returns the session ID and participant token.

```json
{
  "sessionId": "session_123",
  "mode": "voice",
  "participantToken": "livekit-participant-token"
}
```

Do not return the LiveKit WebSocket URL to the first-party page; it already uses `NEXT_PUBLIC_LIVEKIT_URL`.

There is no separate public egress-start route. Room creation, dispatch, egress, and participant-token creation are one idempotent activation orchestration.

### 8.4 Failure and retry behavior

- If durable `chat/` initialization fails, no LiveKit resources are created.
- If LiveKit setup partially fails, clean up room/dispatch/egress and leave the assignment retryable.
- Repeating Start with the same idempotency key returns the same successful activation.
- A reconnect to an active voice session mints a new participant token but does not create another session, room, dispatch, or egress job.

## 9. Durable `chat/` session

Activation explicitly initializes the durable conversation before the first learner exchange.

Conceptual internal request:

```http
POST /internal/sessions
Authorization: service identity
```

```json
{
  "sessionId": "session_123",
  "orgId": "org_123",
  "mode": "voice",
  "contextVersion": 1
}
```

`chat/` then loads factual context from `web/` and stores the durable conversation under `session_123`.

The durable session contains:

- Conversation turns.
- Tool calls and results.
- Current interview progression.
- Pending workspace commands.
- Interruption/cancellation state.
- Finalization state.

The session must be idempotently creatable and reject cross-org reuse.

## 10. Exchange flows

### 10.1 Chat

```text
learner text
  → durable chat session
  → prompt/reason/tool loop
  → authenticated web retrieval when needed
  → workspace command when needed
  → streamed trainer text
  → browser
```

### 10.2 Voice

```text
learner audio
  → LiveKit STT
  → thin agent worker
  → durable chat session
  → prompt/reason/tool loop
  → authenticated web retrieval when needed
  → streamed trainer text
  → LiveKit TTS
  → learner audio
```

Interruption:

1. LiveKit detects learner interruption.
2. Worker cancels current TTS and the in-flight `chat/` response.
3. `chat/` treats the latest finalized learner utterance as authoritative.
4. Already confirmed workspace actions remain in durable state.

## 11. Durable workspace command and screen-state ledger

### 11.1 Existing `feat/agent-ui-state` foundation

The merged branch includes:

- `POST/GET /api/sessions/{id}/ui-state` with runtime-token authentication.
- Browser reporting of surface open/close state.
- Persistence in `InterviewSession.runtimeState.uiState`.
- `getSessionContext` returning `uiState`.
- `chat/` prompt grounding from browser-confirmed screen truth.

This prevents the brain from referring to a panel the learner closed.

### 11.2 Target command flow

Remove LiveKit RPC from the workspace path entirely.

```text
chat durable session
  → appends workspace command with callId/status=pending
  → page observes command through durable session events/state
  → page executes command
  → page posts tool result and confirmed uiState
  → chat records result and resumes the same tool loop
```

Example command:

```json
{
  "callId": "call_123",
  "tool": "surface",
  "input": {
    "action": "highlight_document",
    "payload": {
      "fileId": "doc_123",
      "highlightQuery": "Architected real-time AI systems"
    }
  },
  "status": "pending"
}
```

Example result:

```json
{
  "callId": "call_123",
  "status": "completed",
  "result": { "ok": true },
  "uiState": {
    "active": "pdf",
    "key": "doc_123"
  }
}
```

Ownership distinction:

- `chat/` durable history is authoritative for command intent, call IDs, and tool results.
- Browser-confirmed `web.runtimeState.uiState` is authoritative for what is currently visible.
- `agent/` does not relay or store workspace state/commands.
- LiveKit data packets and RPC are not used for workspace synchronization.

Requirements:

- Commands survive refresh/reconnect.
- Results are idempotent by `callId`.
- A stale result cannot satisfy a newer call.
- Pure side-effect completion does not generate an extra trainer utterance.
- The same protocol works in chat and voice.

## 12. Retrieval and internal tool flow

`chat/` uses service-authenticated `web/` endpoints for:

- `getSessionContext`
- `readDocument`
- `searchKnowledge`
- `searchStyleEpisodes`
- episodic learner-history retrieval
- session lifecycle updates

Rules:

- `web/` returns facts/data, not behavioral instructions.
- `chat/` remains the only component deciding whether and how retrieval affects the response.
- Uploaded documents are untrusted data and never prompt authority.
- Retrieval traces are attached to the durable conversation/report for audit.

## 13. Session closure

Closure sources:

- `chat/` invokes `finish_session`.
- Learner clicks End.
- Administrator cancels an active session.
- Session expires/times out.
- Fatal runtime failure.

Unified close orchestration:

1. Atomically move `InterviewSession` from `active` to `closing`.
2. Stop accepting new learner turns.
3. Ask `chat/` to finalize the durable session.
4. If voice, stop/finalize egress.
5. Store recording metadata.
6. Disconnect participants and close the room.
7. End the worker dispatch.
8. Persist final transcript, evidence, usage, retrieval traces, and report.
9. Mark `completed`, `abandoned`, or `failed`.

Every step is idempotent and retryable.

## 14. Proposed implementation phases

### Phase 0 — Integration baseline

- Merge current `main` with `feat/agent-ui-state`.
- Preserve current main's assignment/prejoin, question, choice, whiteboard, and shared-KB behavior.
- Preserve UI-state ledger and modernized single-brain prompt contract.
- Resolve prompt/context conflicts intentionally rather than choosing an entire side.
- Establish passing chat/web checks before feature implementation.

### Phase 1 — Deployment and assignment model

- Add/normalize stable deployment records and keys.
- Make assignments reference deployments, not scenario versions.
- Remove eager `InterviewSession` creation from assignment.
- Add assignment statuses `pending`, `used`, `expired`, `cancelled`.
- Update assignment email to use the org subdomain.
- Add migration/backfill for current assigned sessions.

### Phase 2 — Prejoin and activation orchestrator

- Keep the centered two-column learner card.
- Restrict prejoin to one newly selected file; no historical-upload picker.
- Add one idempotent Start command.
- Resolve latest published deployment and create the immutable session snapshot.
- Ensure assignment and document ownership checks are org-scoped.
- Add retry-safe activation/cleanup state.

### Phase 3 — Explicit durable `chat/` sessions

- Add idempotent internal create/finalize/cancel operations in `chat/`.
- Use `InterviewSession.id` as the durable conversation address.
- Separate stable deployment identity from session capability.
- Ensure both delivery modes invoke the same durable session.
- Persist conversation events/traces to `web/` without making `web/` a second brain.

### Phase 4 — Thin voice activation

- Move room creation, dispatch, egress, and participant-token minting into activation.
- Remove LiveKit work from assignment/session-preparation paths.
- Keep LiveKit URL in first-party public configuration.
- Pass only organization/session routing metadata to the worker.
- Remove prompts and business tools from `agent/`.

### Phase 5 — Durable workspace commands

- Retain the merged browser-confirmed UI-state ledger.
- Add durable command/result events keyed by `callId`.
- Add a page subscription to session commands independent of LiveKit.
- Return command results and confirmed UI state through the durable protocol.
- Remove workspace RPC/data-packet tools from `agent/`.
- Verify refresh, reconnect, close-panel, stale-result, and side-effect-suppression behavior.

### Phase 6 — Chat/widget integration

- Add stable public/server deployment keys.
- Add SDK/widget session creation.
- Add allowed-origin, rate, quota, and revocation policy.
- Return browser conversation capability for chat mode.
- Keep session-token refresh automatic inside the SDK.

### Phase 7 — Unified close and observability

- Consolidate close orchestration.
- Correlate web session, chat durable session, LiveKit room, dispatch, and egress by one ID.
- Add activation/close idempotency tests.
- Add transcript/retrieval/tool/egress audit trails.
- Add recovery checks for partial activation and partial close failures.

## 15. Expected file areas

### `web/`

- Assignment and session models/migrations.
- Deployment APIs and key management.
- Org-subdomain assignment pages.
- Prejoin upload UI.
- Activation and close orchestrators.
- Internal chat context/retrieval/lifecycle endpoints.
- Durable browser UI-state projection.
- LiveKit admin/egress operations.

### `chat/`

- Durable session create/finalize/cancel contract.
- Unified OpenAI-compatible exchange endpoint.
- Session capability validation.
- Tool command/result event ledger.
- Single prompt/tool registry for chat and voice.

### `agent/`

- STT → chat → TTS adapter.
- Interruption/cancellation propagation.
- Remove prompt and workspace tool ownership.

### `bench/`

- API-only activation simulations.
- Chat and voice parity assertions.
- File-attached prejoin tests.
- Durable workspace command/result tests.
- Close-loop and partial-failure simulations.

## 16. Acceptance criteria

### Assignment

- Sending an assignment creates no `InterviewSession`, chat session, room, dispatch, token, or egress.
- Links use the organization subdomain.
- Expired/cancelled/used links cannot activate.

### Prejoin

- Learner sees only name, session name, one-file upload, and Start.
- Past uploads are not shown.
- Required document validation happens before Start.

### Activation

- Exactly one session is created per successful Start/idempotency key.
- Session snapshots current published configuration.
- `chat/` durable session exists before the first turn.
- Voice activation creates one room, dispatch, egress, and participant token.
- Chat activation creates no LiveKit resources.

### Conversation

- Chat and voice produce responses from the same `chat/` brain.
- `agent/` contains no independent prompt/policy/tool registry.
- Knowledge/style/document retrieval comes through authenticated `web/` APIs.

### Workspace

- No workspace command/state uses LiveKit RPC or data packets.
- Commands survive reload and reconnect.
- Browser-confirmed state is reflected in subsequent brain turns.
- A closed panel is never described as open.
- Tool results resume the correct durable call exactly once.

### Closure

- `finish_session` terminates the conversation without goodbye loops.
- Egress finalizes exactly once.
- Room and dispatch are cleaned up.
- Transcript/report/recording correlate to one session ID.

## 17. Migration notes

- Preserve existing completed sessions unchanged.
- Convert unused assigned-session rows into assignment-only records where safe.
- Keep compatibility reads during migration; stop new eager session creation first.
- Existing LiveKit runtime tokens remain valid only for their original sessions.
- Introduce deployment keys without exposing current internal slugs as credentials.
- Remove old RPC workspace paths only after durable command/result parity is verified.

## 18. Explicit non-goals for the first implementation

- Multiple prejoin files.
- Multiple concurrent attempts from one assignment.
- Dynamic LiveKit project selection.
- Customer-managed STT/TTS providers.
- A second brain for voice.
- Replacing LiveKit egress.
- Rebuilding existing retrieval/indexing systems.
