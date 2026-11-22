# Role-play v1 and v2: comparison and workspace compatibility

Status: source audit plus read-only production configuration inspection; fixes and browser verification are local on `roleplay`, not deployed. See [Session workspaces](../specs/workspaces.md) for the shared transport implementation and its acceptance criteria.
Baseline: `ad2cd97` (PR #20). These labels mean content formats, not `/api/v1` versus another API version.

## Actual configuration

Read-only production inspection found:

- careerwithvasanth: 10 unarchived interview-format ROLEPLAY records, no skill and no top-level `data.tools`.
- latencytest: 5 more interview-format ROLEPLAY records, also without top-level tools. Organization alone does not determine the format.
- olga: 9 builder-format ROLEPLAY records (`source: roleplay-skill`, with a skill), also without top-level tools. They remain opt-in: missing tools must not accidentally turn sales conversations into technical interviews.

No production records were changed. No live call was performed to establish model or browser behavior.

## Product and implementation

| Area | v1: interview role plays (Vasanth) | v2: builder/client role plays |
| --- | --- | --- |
| Purpose | An interviewer assesses the learner's technical knowledge, coding, system design, or resume claims. | The AI plays a client/person in a situation. The learner practices responding. |
| Authoring | Legacy agent/spec editor and interview drafts. Generation can use a model. | Scenario, Scoring, Settings, Tools tabs. Form renders a skill package deterministically. |
| Stored content | `objective`, `opening`, `instruction`, `stages`, `config.interview`; published history/draft revisions. | `skill`, `scenario.roleplay`, difficulty/reactions/hidden truth; scoring goals and rubric in `after`. |
| Studio route | `/agents/<slug>` and its editor. | `/roleplay/<slug>` and its editor. The library links according to source. |
| Conversation | `roleplay-interview`, session plan, question counts, follow-up allowances, evidence and resume claims. | `roleplay-client`, stays in character, opening, difficulty and earned disclosure; no interview plan. |
| Persona | Interviewer's identity/voice/style. | Character/client identity/voice; role-play-specific name and speaking style can override. |
| Workspace | Originally available to interview tools; no top-level switches were saved on existing records. | Four explicit switches: whiteboard (`canvas`), editor (`codeEditor`), PDF (`preview`), MCQ (`choice`). |
| Report | Existing interview report at `/sessions/<id>`. | Role-play goals/rubric report at `/roleplay/sessions/<id>`, normalized score and feedback. |
| Assignments | Same personal link/access model as v2. | Same personal link/access model as v1. |
| Attempts | Many sessions per assignment while access and credits allow; live role-play call can resume. | Same. |
| Snapshot | Session pins content/persona versions and configuration at Start. | Same. |
| Public integration | `/scenarios`, `/assignments`, `/sessions`; includes this format. | Same API. No authoring or call-start endpoint. |

The new client format is not a replacement interview engine. A compatibility fix must not convert Vasanth's interviews into client-mode skills or rewrite their plans/scoring.

## Workspace path shared by both formats

1. `getSessionContext` returns the session's pinned agent data and live immutable kind.
2. Chat resolves tools and includes enabled capabilities in the model's tool list and prompt.
3. `executeWorkspaceTool` rechecks permission, then calls Studio's `enqueueWorkspaceCommand`.
4. Studio stores a durable `WorkspaceCommand` and waits for its result.
5. `LiveKitWorkspaceProvider` polls pending commands with the browser session token, parses surface payloads, and mounts the editor/whiteboard/PDF/choice component.
6. Browser posts the acknowledgement or failed result. Inspection tools use registered browser handlers.

The active path is not Python workspace RPC. Voice supplies no workspace tools because chat owns this command loop. Re-enabling the old Python tools would duplicate it.

## Confirmed failures and bounded fixes

### 1. Legacy tools disappear before reaching the browser

Commit `874abc1` replaced static workspace tools with a resolver using only top-level `data.tools`. Its message explicitly warned that interviews without saved switches lose their tools. All 10 inspected Vasanth role plays match that case. Interview instructions still require editor/whiteboard/MCQ, but the model cannot call a tool that is absent.

Local fix: for an identified ROLEPLAY with no `data.tools`, no skill, and a recognized legacy `config.interview.type` (`technical` or `resume`), preserve the four original workspace capabilities. Explicit settings (including empty, null, partial, or all-false) still win. Twins, new client skills, unknown data and lookup failures remain default-off. This is format compatibility, not an organization allowlist. It needs no data migration.

Both web and chat resolve the same policy; chat passes kind for prompt rendering, dynamic tool discovery and execution. Web uses it when showing or patching settings so a partial copilot edit does not silently disable the other legacy tools.

### 2. Resume questions are denied even when preview is on

`start_resume_question` calls the shared workspace executor under its own name. That name was missing from the switch map, so every such call returned the disabled result. The resume tool then interpreted the missing status as `viewer_unavailable`.

Local fix: map `start_resume_question` to `preview`. Existing Studio validation of eligible claim, question, session and document is unchanged. Explicit preview-off still denies it.

### 3. Pre-warmed opening can suppress the initial PDF

`web/lib/session-warm.ts` says warming fetches style but leaves the surface decision to the model. The pre-warm instructions in `chat/agent/lib/brain.ts` and `chat/prompts/base-instructions.md` instead assume the document is already open and prohibit `surface` on the opening turn.

The transport pass now corrects both conflicting instructions: warming skips redundant style/plan retrieval but permits opening the actual PDF. Golden/instruction tests protect the wording. Model selection of that tool during a real voice opening still needs a live rehearsal; browser tests explicitly invoke the tool and verify the PDF.

### 4. Workspace awareness can be stale

Browser reports state to `/api/sessions/<id>/ui-state`, but `choice` is absent from its accepted surfaces. Session context has a 24-hour cache and instructions also memoize context, so the initial WORKSPACE STATE block is not a live feed. Explicit inspection tools are separate.

The transport pass now adds choice, atomic UI-state field updates with revision ordering and bounded browser retries, and a separate per-turn workspace-state read outside the immutable session memo. Database and instruction tests verify updates reach later reads without rebuilding the configuration.

### 5. Not every old documented surface is supported

The original dynamic resolver omitted image/presentation actions and slide navigation. The transport pass now enables these through Preview, connects all slide tools to the existing presentation viewer, converts zero-based tool indices to one-based browser requests and waits for actual viewer state before acknowledging navigation. Browser tests load PDF/image/PPTX and exercise real slide changes. Upload acceptance policy is not expanded by these display tools.

## Verification and release boundary

- Add regression coverage for technical and resume legacy defaults, explicit off/partial settings, new clients, twins, malformed data and failed lookups.
- Exercise actual dynamic resolution and shared execution for editor/whiteboard/MCQ/PDF, plus preview-gated resume questions.
- Check browser payload parsing and command acknowledgement separately from offering tools.
- A live call still needs to prove model call -> durable command -> visible workspace -> learner interaction -> successful tool result. Unit checks are not that rehearsal.
- No production deployment or configuration writes are authorized by this comparison. Existing cached sessions/tool lists may require a new session after any future release.
