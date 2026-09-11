# Issue 3: Setup LiveKit Agent Client in `@web` (/talk Route)

## Context & Objectives
Polish and stabilize the `/talk` route frontend client. Leverage `@livekit/components-react` canonical prefabs and hooks, keep participant roles limited to trainer and learner, and bring over workspace surface tools from the reference implementations (`trainertwin/demo` and `trainertwin/agent-demo`).

---

## Decisions & Requirements

1. **Leverage LiveKit Components**
   - Rely on `@livekit/components-react` built-in components and layout patterns wherever possible (`LiveKitRoom`, `RoomAudioRenderer`, `useVoiceAssistant`, `useTrackToggle`, `useStartAudio`, `useTrackVolume`, `Chat`).
   - Avoid reinventing custom audio renderers, WebRTC connection state machines, or track subscriptions.

2. **Scoped Participant Roles**
   - Two participant roles only:
     - **Trainer**: Remote agent participant (`kind === AGENT`).
     - **Learner**: Local participant with audio/microphone capture.
   - No observer/evaluator roles in `/talk` for now.

3. **Workspace Surfaces Integration**
   - Port and integrate workspace surfaces from reference demo projects:
     - `trainertwin/demo`
     - `trainertwin/agent-demo`
   - Surfaces required:
     - **Code Editor**: Language selection, syntax highlighting, starter code, run/test execution via RPC (`workspace.code`).
     - **Canvas / Whiteboard**: Interactive drawing board synced via agent data packets / RPC (`workspace.canvas` / `workspace.whiteboard`).
     - **Document Viewers**: PDF viewer and Presentation viewer for context slides and reference materials.
   - Sync surfaces dynamically when agent triggers tool actions via LiveKit RPC / data packets.

4. **Exit Confirmation & Session Persistence**
   - Maintain the `AlertDialog` confirmation prompt on "End Session" to prevent accidental dropouts.
   - Finalize session transcript and evidence coverage cleanly upon room disconnection.

---

## Action Items

- [ ] Review `trainertwin/demo` and `trainertwin/agent-demo` surface components (`CodeEditor`, `Canvas`, `PdfViewer`, `PresentationViewer`).
- [ ] Align `@web/components/session/` surface components with the battle-tested implementations in `demo` and `agent-demo`.
- [ ] Verify agent RPC method registration and tool invocation (`workspace.surface`, `workspace.code`, etc.) inside `LiveKitWorkspaceProvider`.
- [ ] Test split-stage responsive layout when surfaces open and close during live agent interaction.
