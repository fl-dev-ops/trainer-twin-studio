# Issue 3: Setup LiveKit Agent Client in `@web` (/talk Route)

## 1. Context & Objectives
Polish, stabilize, and verify the `/talk` route frontend client in `@web`. Rely on `@livekit/components-react` canonical prefabs and hooks, keep participant roles limited to trainer and learner, and ensure workspace surface tools (`code-editor`, `canvas`/whiteboard, `pdf-viewer`, `presentation-viewer`) match the battle-tested implementations in `trainertwin/demo` and `trainertwin/agent-demo`.

---

## 2. Progress & Completed Implementations

The following core client architecture updates were completed in commits `a52c212`, `8758a7e`, and `3012f35`:

1. **Canonical `<LiveKitRoom>` Container**
   - Refactored `web/components/session-view.tsx` from raw manual `Room` management to `@livekit/components-react`'s `<LiveKitRoom>`.
   - Wired audio capture defaults (`autoGainControl`, `echoCancellation`, `noiseSuppression`), dynamic stream adaptation, and `<RoomAudioRenderer />`.
   - Fixed stage viewport collapse by pinning the outer container to `fixed inset-0 z-50 h-dvh w-dvw` and passing `flex-1 h-full w-full flex flex-col` down to the stage.

2. **Refined Control Bar & Exit Confirmation**
   - Updated `web/components/session/session-control-bar.tsx` using LiveKit hooks (`useTrackToggle`, `useStartAudio`).
   - Autoplay unlock ("Enable audio") renders conditionally only when `!canPlayAudio`.
   - Added an `@base-ui/react` based `AlertDialog` on "End Session" to confirm exit before disconnecting and prevent accidental dropouts.

3. **Tabbed Sidebar with LiveKit `<Chat />`**
   - Created `web/components/session/session-sidebar.tsx`.
   - Features tabbed switcher between real-time STT **Transcript** (with topic coverage badges) and live room **Chat** using LiveKit's `<Chat />` component.

4. **Session Lifecycle Fixes**
   - Fixed premature session abandonment in `web/components/session-view.tsx`: removed component-unmount cleanup that previously wiped `runtimeTokenHash` to `NULL` during React StrictMode mount/remount.
   - Bound finalization strictly to `room.on(RoomEvent.Disconnected)` and explicit exit actions.
   - Fixed persona avatar matching in `AgentTile` to use case-insensitive slug (`persona.toLowerCase() === "vasanth"`).

5. **Hardenings (2026-09-12, this issue)**
   - Fixed "Preparing…" stuck indicator: `interviewReady` was gated on `session-started` / `interview_question_started` data packets that nothing in the runtime emits; it now derives from `useVoiceAssistant().state` (agent audio present = interview begun).
   - Removed dead data-packet handlers (`session-started`, `interview_question_started`) from `session-view.tsx`; only the `session-ended` fallback (sent when `session.end` RPC fails) remains.
   - Added `ParticipantKind.AGENT` caller guard to every workspace RPC (`workspace.code`, `workspace.canvas`, `workspace.whiteboard`, `workspace.presentation`, `workspace.surface`, `surface`, `session.end`) and to agent data packets — matching the demo reference's trust boundary. Non-agent callers receive `{ok:false}` / are ignored.
   - `surfaceForPhase` now forwards `starter_code` from a phase's `coding_sandbox` tool object into the `open_code_editor` payload (unit tested).

---

## 3. Reference Implementation Comparison (`demo` & `agent-demo`)

The reference projects implement rich workspace surfaces wired to LiveKit agent data packets and RPC:
- `trainertwin/demo/components/code-editor.tsx` & `whiteboard.tsx`
- `trainertwin/agent-demo/src/components/session/code-editor-panel.tsx` & `whiteboard-panel.tsx`

### Workspace Surfaces to Harden in `@web/components/session/`
1. **Code Editor (`code-editor.tsx`)**
   - Supported languages: Python, JavaScript, TypeScript, HTML, CSS, Java.
   - Monaco / CodeMirror editor with One Dark theme.
   - RPC execution via `workspace.code` (action: `open`, `set_code`, `get_code`, `run`).
   - Run/Test output console panel with stdout/stderr display.

2. **Whiteboard / Canvas (`whiteboard.tsx`)**
   - Excalidraw-based canvas.
   - Synced tool actions via `workspace.canvas` / `workspace.whiteboard` RPC and agent data packets.

3. **Presentation Viewer (`presentation-viewer.tsx`)**
   - Slide presentation renderer supporting remote URL sources.
   - Slide controls: prev, next, jump to slide, zoom.

4. **PDF Viewer (`pdf-viewer.tsx`)**
   - Document viewer for résumé or context documents.
   - Page navigation and zoom controls.

---

## 4. Verification Checklist (Definition of Done)

### LiveKit Client Core
- [x] Canonical `<LiveKitRoom>` wraps active session stage.
- [x] `<RoomAudioRenderer />` renders agent voice playback.
- [x] Control bar provides working mic mute/unmute and chat drawer toggles.
- [x] Exit confirmation `AlertDialog` intercepts "End Session" button.
- [x] Tabbed sidebar switches cleanly between live STT transcript and LiveKit `<Chat />`.
- [x] Stage layout expands to 100% viewport height with control bar pinned to bottom.
- [x] Vasanth portrait displays properly on Agent tile.

### Workspace Surfaces & RPC Tools
- [ ] Agent can open Code Editor via `workspace.surface` or `open_code_editor` RPC/data packet. (mechanism wired: runtime synthesizes `surface` tool call from phase config → Python agent relays over RPC → browser opens component; needs live verification)
- [ ] Code Editor renders starter code and allows candidate code editing. (starter code now flows from a phase's `coding_sandbox` tool config — `starter_code` field — through `surfaceForPhase`; editor shows generic boilerplate until an agent spec sets it)
- [ ] Code execution via `/api/code/run` returns output to console and agent. (OneCompiler-backed; RPC `run`/`get_output` wired both sides; needs live verification)
- [ ] Agent can open Whiteboard / Canvas via `workspace.canvas` RPC/data packet. (mechanism wired; needs live verification)
- [ ] Agent can display PDF / Presentation documents when context is attached. (driven by phase `scenario.pdf_url` / `scenario.presentation_url`; needs live verification)
- [ ] Split-stage smoothly animates between full stage (tiles only) and split stage (surface + compact tiles). (motion layout implemented; needs live verification)
