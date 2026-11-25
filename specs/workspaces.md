# Session workspaces: agent-to-browser contract

Status: implemented and locally verified on `roleplay`, with user-reported session confirmation for PDF and canvas actions. Not deployed by this work; this is not a complete production-release sign-off.
This contract is shared by legacy interview role plays, client role plays, and twins. Content format selects permissions and instructions, not a different browser transport.

## Actors and boundary

- Chat owns workspace tool calls. The Python voice worker carries speech; its old workspace RPC tools are not the active path.
- Studio owns the durable `WorkspaceCommand` row, session/org scope, validation, claims, timeout and terminal result.
- The learner browser owns execution and rendering. It proves ownership with its browser token, never the agent token.
- The model must use returned results, not assume that mentioning a workspace made it visible.

## Supported actions

| Switch | Offered tools/actions | Browser implementation |
| --- | --- | --- |
| canvas | surface open_whiteboard; add_canvas_component; read_canvas_scene; highlight_canvas_element; highlight_whiteboard; clear_canvas | Excalidraw Whiteboard |
| codeEditor | surface open_code_editor; get_code_state; read_code_range; highlight_code; run_code | Monaco CodeEditor and the existing code-run endpoint |
| choice | surface open_choice; get_choice_state; highlight_choice | ChoicePanel; private answer key remains in chat |
| preview | surface open_pdf, highlight_pdf/highlight_document, open_image, open_presentation; start_resume_question; get_presentation_state; set_presentation_slide; next_presentation_slide; previous_presentation_slide | PDF, image and presentation viewers; resume claims remain validated in Studio |
| any enabled switch | surface close_surface; workspace_request to a permitted method | Close panel or route to its registered handler |

`set_presentation_slide.slide_index` is zero-based. Browser presentation `go_to_slide.slideNumber` is one-based; the transport converts it.

Permissions are still enforced before enqueue. Legacy ROLEPLAY interviews with technical/resume config and no skill or saved top-level tools preserve original capabilities. An explicit tools object (even empty/all-false), new client skills, twins, unknown data and failed context lookups do not inherit that default.

Supporting presentation display/navigation does not expand the upload policy: existing before/during file acceptance limits remain. The presentation viewer can also open a learner-selected local presentation using its existing file picker.

## Command protocol

1. Chat's tool executor enqueues a command with sessionId, callId, tool name and payload.
2. A repeated callId must belong to the same session and same tool/input. A different identity is refused, never given another session's result.
3. Resume replay resolves the existing command before checking whether a claim has since been consumed.
4. Browser GET lists pending/running commands for its live call. Browser POST claims one command using an instance UUID.
5. The database transition `pending -> running` chooses one browser. A second tab cannot execute that command. The claim has no automatic takeover: a browser crash is not permission to duplicate a side effect.
6. The browser waits up to twelve seconds for the selected component to mount and become ready. Unknown actions and missing required document sources are failures, not successful no-ops.
7. Handler result and acknowledgement delivery are separate. A failed ACK request retries the same cached outcome; it does not run code, add a box, reset a question or advance a slide a second time.
8. Only the claimant can complete the command. An identical ACK is safe to resend. A contradictory result, late success after timeout, or a different browser's ACK is refused.
9. At thirty seconds from creation, pending/running commands become terminal failures. Expired work is not replayed when a browser returns later. A timeout is not proof that an already-started external action never ran; the caller must not blindly retry a non-idempotent action with a new ID.
10. Browser unmount/session change aborts command fetches and prevents old callbacks from dispatching against the new session. Per-session command identity isolates cached results. Only a browser currently connected to the LiveKit room polls commands or publishes UI state; a duplicate-identity-disconnected tab must not steal actions from the new tab.
11. A live finish-session returns as soon as it is queued, so the goodbye is not stuck behind the browser. The browser mutes, tells the voice worker to leave, and acknowledges only after that goodbye has played or 25 seconds have passed. The server then closes the call. A browser that never acknowledges still gets a server-side end when the command times out. A browser-less call keeps the five-second goodbye window. A failed command stays failed.

No browser test fixture is shipped as a production route. The isolated component harness lives under `web/e2e/workspace/`.

## Mutable workspace state

- Browser publishes active surface, resource key and a monotonic revision; `choice` is included.
- Failed state POSTs are retried boundedly. Older revisions cannot overwrite newer reports. SQL patches only uiState, preserving unrelated runtime fields.
- Session instructions memoize immutable content, not workspace state. Every model turn reads current UI state separately through the secret/org-scoped getWorkspaceState action.
- State identifies the open panel. Code, drawings, selection and slides still require inspection tools; an old screenshot or a cached state block is not evidence of current content.
- Warming retrieves opening style only. It does not open the resume. A pre-warmed interview may still call surface open_pdf for an actual attachment when preview is enabled.

## Local verification checkpoint

The combined run `/tmp/trainertwin-workspace-final.sC1Yiv` passed:

- `web/e2e/workspace/workspace.spec.ts`: 12 real-browser cases; actual chat executor, Studio routes, PostgreSQL command queue and browser components. Compiler response and document assets are controlled fixtures, not live external providers.
- `web/tests/lib/workspace-commands.db.test.ts`: 10 focused database tests for claims, replay, isolation, expiry, server-side end fallback/grace and mutable UI state. Included in the full 751-test DB pass.
- 150 flow tests; 1,088 web unit tests; 128 chat tests.
- Web/chat type-checks, touched production-file lint, production build and whitespace/diff checks.
- UI mechanical detector reported no findings. Two independent Grok review attempts failed to produce reports (turn/time limits); they are not approvals.

Browser tests prove editor open/read/highlight/run/close and replacement, whiteboard add/read/highlight/clear and fresh-question reset, choice selection/highlight, PDF/image loading, ordinary and resume highlights, slide navigation with current state, acknowledgement recovery, duplicate-tab claims, expiry and invalid actions. They do not run the LLM, microphone/TTS, LiveKit room connection or production services.

User session check: the user reported PDF preview, PDF highlighting, canvas opening and block creation working without issues. The environment was not specified. This confirms those observed actions, not every workspace action or external provider.

Implementation: `chat/agent/lib/agent-tools.ts`, `workspace-tools.ts`, `workspace-state.ts`, `chat/agent/tools/workspace.ts`, `chat/agent/instructions/session-spec.ts`; `web/lib/workspace-commands.ts`, `livekit-workspaces.tsx`, `presentation-rpc.ts`; `web/app/api/sessions/[id]/commands/`, `ui-state/`, `web/app/api/copilot/studio/route.ts`; `web/components/session-view.tsx` and `web/components/session/`.

## Acceptance and release boundaries

- Capability tests: v1 compatibility, v2/twin defaults, explicit off, and denied unknown tools/actions.
- Database tests: single claimant, conflicting IDs, cross-session isolation, result replay, used-resume-claim replay, timeout/late ACK, and stale UI-state updates.
- Browser tests using real components and actual chat executor -> Studio -> database -> browser -> result: code open/read/highlight/run, canvas add/read/highlight/clear, choice selection/highlight, PDF/image loading, slides and resume highlight.
- Retry tests: failed/network-lost acknowledgements, two tabs, delayed component mount, reconnect, unknown actions and unavailable files.
- Compiler responses/file bytes may be controlled test fixtures. This does not verify the live compiler provider, LLM tool selection, microphone/TTS or production transport. The user-reported PDF/canvas session check is recorded above; remaining live actions and provider integration still need acceptance checks.
- Refresh existing tabs for this protocol change and apply the nullable command-claim migration before new code if later approved for deployment.
