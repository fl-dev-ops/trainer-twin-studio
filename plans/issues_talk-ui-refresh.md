# Issue: /talk UI — visual design refresh (Riverside-style studio)

**Status:** planned · **Type:** UI refactor (visual/design refresh + headless hook architecture) · **Priority:** high

## Goal

Restyle the `/talk` live-session UI to match the approved Riverside-style studio design verified in `talk-preview.html`: a dark full-screen canvas with card-style participant tiles, an audio-first AI agent orb for Vasanth, an edge-to-edge layout where the stage and chat sidebar share the exact same height, a common bottom footer with floating control dock, YouTube-style live streaming subtitles, and a pure-gray chat panel.

All existing session behavior, room lifecycle, contracts, and agent interactions are preserved byte-for-byte.

**Prototyped & verified in:** `talk-preview.html` (and `web/public/talk-preview.html`).

---

## Part 1 — Approved UI & Behavior Specification

### 1.1 Top Navigation Bar
- **Left**: TrainerTwin mark icon (`#ec3013`) + "TrainerTwin" bold clean wordmark.
- **Right**: Red pill badge `● Live 00:09:41` with pulsing red dot and monospace elapsed timer (`font-mono`, tabular figures).
- **Height**: 56px, subtle bottom border (`rgba(255, 255, 255, 0.035)`), semi-transparent background with backdrop blur.

### 1.2 Main Stage & Chat Layout (Equal Height)
- The main body (`studio-main`) contains two direct child columns:
  1. **Stage Section** (left, `flex: 1`, min-width: 0)
  2. **Chat Sidebar** (right, fixed 360px, collapsible to 0)
- **Both columns share the exact same top and bottom horizontal boundaries.**
- The stage and sidebar stop above the common footer.

### 1.3 Participant Tiles & Presentation Surface
- **Normal Mode** (Screen share / surface closed):
  - Two large rectangular rounded cards (`border-radius: 16px`, background `#1c1f26`, hairline border `0.035`) side-by-side, sharing the stage 50/50.
  - **Left: Trainer AI Card (Vasanth)**
    - Audio-only AI voice agent (no webcam video).
    - Centered avatar orb (110px circle with Vasanth portrait).
    - **Speaking State**: Green fluid pulse rings radiating from the orb, glowing card border (`rgba(16, 185, 129, 0.45)`), solid green dot in bottom-left name pill `Vasanth ●`.
    - **Thinking State**: Amber/gold hypnotic breathing aura around orb, amber card border, pulsing amber dot in `Vasanth ●`.
    - **Listening State**: Calm subtle cyan halo around orb, cyan dot in `Vasanth ●`.
    - **No text labels** (e.g. no "Speaking" or "Thinking" text strings) on the card itself.
  - **Right: Candidate Card (You)**
    - Centered audio circle (64px dark circle `#323742` with white microphone icon).
    - Mic Active: Violet/purple audio pulse rings radiating outwards.
    - Mic Muted: Dark circle `#252830`, halo rings hidden, mic off icon.
    - Bottom-left name pill: `You ●` (green when active, red when muted).
    - Bottom-right icon: camera off indicator.
- **Presenting Mode** (Screen share / agent surface open):
  - Triggered when candidate clicks the Screen Share button or when the AI agent opens a surface (`workspace.code`, `workspace.canvas`, `workspace.presentation`, `workspace.pdf`, `workspace.image`).
  - **Left (Large)**: Presentation Workspace Surface (Code Editor / Whiteboard / PDF / Presentation).
  - **Right (Vertical Stack)**: **All participant tiles automatically move to the right side stacked vertically** in a 280px column:
    - Top: Trainer AI Card (Vasanth) with compact 72px orb.
    - Bottom: Candidate Audio Card (You).
  - Chat sidebar stays docked to the right of the vertical tiles column (or can be collapsed).

### 1.4 YouTube / Prime Video Style Live Subtitles
- Floating subtitle box positioned centered at the bottom of the active stage area (`bottom: 22px; left: 50%; transform: translateX(-50%)`).
- **Styling**: Translucent black rounded box (`background: rgba(0, 0, 0, 0.84)`, `border-radius: 6px`, `padding: 6px 14px`, `box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6)`).
- **Text**: Crisp white 15px text with subtle text shadow (`0 1px 2px rgba(0,0,0,0.8)`).
- **No speaker prefix** (no `VASANTH:`). Pure subtitle text.
- **Display condition**:
  - **Visible ONLY when the agent is actively Speaking.**
  - **Completely hidden** during *Thinking* and *Listening* states.
  - Can be toggled on/off via the `[CC]` button in the footer control dock.

### 1.5 Right Sidebar: Pure Chat (Monochrome Gray)
- **Header**:
  - Left: Collapse chevron `›` (clicking collapses sidebar to `width: 0`).
  - Center: `Chat` tab title with neutral gray unread count badge (`12`) and subtle underline.
  - Right: Message input toggle button (keyboard icon).
- **Messages Stream**:
  - **Trainer messages**: Dark subtle gray bubble (`#1e2127`, text `#e5e7eb`).
  - **Candidate messages**: Contrasting medium-light gray bubble (`#2e333d`, text `#ffffff`, subtle shadow).
  - **Zero accent colors**: No blue/purple bubble backgrounds.
  - Live status indicator: shows `Speaking…` when agent speaks, `Thinking…` when agent thinks, hidden when listening.
- **Message Input**:
  - Rounded capsule input bar at the bottom with gray send button.
  - Toggleable via the keyboard icon in the sidebar header (hidden for production/testing as needed).

### 1.6 Common Bottom Footer (Floating Control Dock)
- Positioned in a common horizontal bottom bar spanning across the entire screen width, centered below both the stage and chat sidebar.
- Floating capsule dock (`#1b1e24`, rounded-full, `padding: 6px 14px`, `gap: 10px`, shadow):
  1. **Video** (camera toggle)
  2. **Mic** (microphone mute/unmute toggle)
  3. **Screen Share** (presentation surface toggle)
  4. **Live Subtitles / Transcript** (`[CC]` icon button — toggles the floating subtitle box)
  5. **Chat** (message bubble icon — toggles the chat sidebar open/collapsed)
  6. **End Call** (distinct red circular button `#e03b3b` with phone-off icon, opens confirmation alert before ending)

---

## Part 2 — Explicit Exclusions (What We Do NOT Want)

1. **NO keyboard shortcuts in `@web`**: Shortcuts (<kbd>T</kbd>, <kbd>P</kbd>, <kbd>M</kbd>, <kbd>C</kbd>, <kbd>L</kbd>) were strictly for prototype testing in the static HTML preview; do NOT bind window keyboard listeners in production.
2. **NO user profile avatar button in the header**: Only TrainerTwin logo on left, and red Live timer badge on right.
3. **NO header scenario pills or participant badges**: Dropped `/project-experience-deep-dive` and `👥 2`.
4. **NO session status / coverage card in the sidebar**: Dropped the "Project Deep Dive" progress card with audio stats and topic chips. The sidebar is pure Chat.
5. **NO Participants tab**: Dropped entirely. Chat only.
6. **NO floating expand tab on the stage edge**: Opening/closing the chat sidebar is driven only by the chevron inside the sidebar header and the Chat button in the footer dock.
7. **NO blue/purple accent colors in chat bubbles**: Pure light and dark shades of gray only.
8. **NO speaker prefix in subtitles**: No `VASANTH:` or names. Subtitles stream clean text.
9. **NO subtitles when thinking or listening**: Subtitles only show while speech is active.
10. **NO complex status strings**: In chat, only `Speaking…` and `Thinking…` (never "evaluating answer...").
11. **NO pre-packaged LiveKit UI components**: Do NOT use `<Chat>`, `<ControlBar>`, `<ParticipantTile>`, `<FocusToggle>`, etc. from `@livekit/components-react`. All UI markup and CSS is 100% custom.

---

## Part 3 — Architectural Rule: UI First, Then Headless LiveKit Hooks

### 3.1 Principle
1. **Build the complete UI in React + Tailwind CSS + Framer Motion first**, matching the DOM structure and CSS of `talk-preview.html` 1:1.
2. **Do NOT let LiveKit component libraries dictate DOM structure or styling.**
3. **Bind functionality strictly via headless hooks and native Room event listeners:**

| Feature | Headless Hook / Function |
|---|---|
| AI Agent voice state | `useVoiceAssistant()` (`state: "speaking" \| "thinking" \| "listening"`) |
| Agent volume level / pulse | `useTrackVolume(voiceAssistant.audioTrack)` |
| Candidate mic status | `useLocalParticipant()` (`isMicrophoneEnabled`, `microphoneTrack`) |
| Candidate mic toggle | `room.localParticipant.setMicrophoneEnabled(!micOn)` |
| Live subtitles & chat transcription | `room.on(RoomEvent.TranscriptionReceived, handleTranscription)` |
| Sending chat text | `room.localParticipant.publishData(payload, { reliable: true })` |
| Opening greeting release | `room.localParticipant.publishData(JSON.stringify({ type: "begin-opening" }))` |
| Agent surface RPCs (code/canvas/etc.) | `LiveKitWorkspaceProvider` (`registerRpcMethod`, `useWorkspaceHandlers()`) |
| Disconnect & session finalize | `room.disconnect()` + `fetch("/api/sessions/finalize")` |
| Audio playback | `<RoomAudioRenderer />` (headless audio sink only) |

---

## Part 4 — File Breakdown & Implementation Steps

### Files to Touch in `web/`:
| File | Action | Description |
|---|---|---|
| `components/session-view.tsx` | Rewrite | Fullscreen layout, header, equal-height stage+sidebar, common footer, state wiring |
| `components/session/agent-tile.tsx` | Rewrite | Audio-first AI agent card with voice orb, state halos (speaking/thinking/listening), name pill |
| `components/session/candidate-tile.tsx` | Rewrite | Audio card with mic center button, pulse rings, name pill, camera indicator |
| `components/session/session-sidebar.tsx` | Rewrite | Pure Chat sidebar, custom message stream (gray bubbles), live status line, toggleable input |
| `components/session/session-control-bar.tsx` | Rewrite | Common floating dock with Video, Mic, Screen Share, CC Subtitles, Chat, End Call |
| `components/session/live-subtitles.tsx` | **Create** | YouTube/Prime style streaming subtitle banner |
| `components/session/transcript-panel.tsx` | **Delete** | Dead code |
| `app/globals.css` | Update | Remove legacy `.session-*` rules, add studio tokens if needed |

### Steps:
1. **Step 1: Components Creation (UI First)**
   - Create `components/session/live-subtitles.tsx` (subtitles box).
   - Rebuild `agent-tile.tsx` as the AI agent orb tile with speaking/thinking/listening visual states.
   - Rebuild `candidate-tile.tsx` as the audio card.
   - Rebuild `session-control-bar.tsx` as the 6-button floating dock.
   - Rebuild `session-sidebar.tsx` as custom pure-chat with monochrome gray bubbles and headless `publishData` sending.
2. **Step 2: Shell Layout Assembly (`session-view.tsx`)**
   - Fullscreen container `studio-fullscreen`.
   - Topbar: Logo left, Live timer badge right.
   - Equal-height main area: Stage + Presentation surface + Vertical tile stack on presentation + Chat sidebar.
   - Common footer at bottom.
3. **Step 3: Wire Headless LiveKit Hooks**
   - Wire `useVoiceAssistant()` into agent tile & subtitles.
   - Wire `useLocalParticipant()` into candidate tile & mic button.
   - Wire transcription stream into subtitles & chat messages.
   - Wire `LiveKitWorkspaceProvider` into surface presentation layout.
4. **Step 4: Cleanup & Local Verification**
   - Delete `components/session/transcript-panel.tsx`.
   - Verify `bun test` passes.
   - Run `bun run lint` and verify typecheck.
   - Local browser test on `/dash/talk` and `/session/[agent]`.
   - Keep commits local; push only when explicitly requested.
