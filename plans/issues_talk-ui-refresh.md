# Issue: /talk UI — visual design refresh (Riverside-style studio)

**Status:** planned · **Type:** UI refactor (visual/design only — no behavior changes) · **Priority:** high

## Goal

Restyle the `/talk` live-session UI to match the reference design (Riverside.fm studio screenshot, 2026-09-13): a dark rounded studio canvas with card-style participant tiles, a right sidebar with **Chat only** (no Participants tab), a recording card with a mono timer, and a floating circular control bar with a red end button. All existing session behavior, contracts, and agent interactions must survive unchanged.

Reference: local screenshot `Screenshot 2026-09-13 at 6.20.42 PM.png` (Riverside studio).

**Explicit user constraints:**
- Sidebar has **only the Chat tab** — no Participants tab.
- Visual/design refresh; existing functionality preserved.

---

## Part 1 — Current implementation inventory (everything /talk does today)

*Source: `components/session-view.tsx` (916 lines), `components/session/*`, `lib/livekit-workspaces.tsx`, `app/globals.css`. This is the behavior contract the refresh must not break.*

### 1.1 Entry pages (all render `SessionView`)
| Page | Mode | Notes |
|---|---|---|
| `/dash/talk` | configure-first | `?agent=` hoists a scenario to the top of the list |
| `/session/[agent]` | `autoStart` | public portal; single agent; intro video; session launches on load once context requirement met |
| `/s/[code]` | `sessionCode` | shared link; launches with `shareCode` instead of `agentSlug` |

### 1.2 Configure stage (pre-join)
- Scenario `Select` (runnable agent specs); trainer persona is derived (`agentPersonas[agent]`), never user-chosen.
- Context document select + inline upload (`/api/upload`; accepts .md/.txt/.pdf/.doc(x)/.ppt(x)/.xls(x)/.csv/.json/images); uploaded files appear as chips (name + size) with remove buttons.
- Per-agent `contextRequired` gate: Start disabled until ≥1 context selected; helper text shown.
- Error text under the form; Start button disabled until scenario + persona (+ context if required) valid.

### 1.3 Launch + room lifecycle
- `POST /api/sessions` with `{ agentSlug | shareCode, contextId, contextIds }` → returns `session.id`, `session.runtimeToken`, `livekit.url`, `livekit.token`. `startedRef` prevents double-launch; failure returns to configure (non-autoStart) with error, retry button available.
- One stable `Room` instance for the whole mount (`useMemo`) — `adaptiveStream`, mic capture defaults (AGC, echoCancellation, noiseSuppression). Remounting it would restart the intro video.
- `room.connect(url, token)`; `connected` state; connect failure → error overlay with Try again.
- Agent-presence tracking: `ParticipantConnected` → `agentInRoom` (greeting packet must not be sent before the agent joins).
- **Opening release** (once, `releasedRef`): when `connected && agentInRoom && (no intro || introDone)` → `setMicrophoneEnabled(true)` + `publishData({type:"begin-opening"}, reliable)`.
- Unmount: `room.disconnect()` cleanup.
- `RoomAudioRenderer` mounted (agent audio playback).

### 1.4 Intro video (`ScenarioIntro`, plays inside the trainer tile)
- Autoplay attempt with sound → fallback: muted autoplay + "Unmute" pill → final fallback: "Tap to play" full overlay.
- Watchdog: once real duration is known, `onFinished` fires at `duration - currentTime + 2s` even if `ended` never fires; `onError` releases immediately.
- Caption bottom-left: persona name (title-cased) · "Speaking".

### 1.5 Live-session data flow
- **Transcription** (`TranscriptionReceived`): final segments only; role by participant identity (user vs trainer); trainer-prefix dedupe (drop last entry if new segment equals or extends it); entries mirrored into `entriesRef` for finalize.
- **Coverage polling**: after each trainer transcript segment, `GET /api/sessions/[id]` with `Authorization: Bearer runtimeToken` → `coverage` map (topic → status) → sidebar badges.
- **Agent data packets** (`DataReceived`, JSON):
  - `session-started` → `interviewReady` (status dot: amber "Preparing…" → green "Connected")
  - `interview_question_started` → `interviewReady` + append `metadata.question.spokenText` as a trainer entry (dedupe vs last)
  - `session-ended` (status completed) → auto-end session as "completed"
- **Elapsed timer** (mm:ss) while launched.

### 1.6 Ending the session
- Three end paths: manual (control bar → AlertDialog confirm), agent-initiated (`session-ended`), unexpected disconnect (`RoomEvent.Disconnected`).
- All paths: `POST /api/sessions/finalize` with `{ sessionId, status: completed|abandoned, transcript, evidence }` (`keepalive: true`), once (`finalizedRef`), then `room.disconnect()`, full state reset, end screen.
- End screen copy varies by reason: completed ("Session complete"), manual ("Session ended"), disconnected ("ended unexpectedly; data saved"). Actions: View sessions (link), New session (reset + reconfigure).

### 1.7 Live stage layout
- Header: logo mark → `/`, "persona × agent" title, timer, ready/preparing status dot.
- Stage (CSS grid in `globals.css`, animated with motion springs):
  - Base: participants grid (trainer tile + candidate tile; two columns ≥48rem).
  - Surface open: surface takes the main area; participants compress into a 7rem strip (two compact tiles below the surface; ≥64rem: surface 1fr + participants 14rem column).
  - AnimatePresence scale/fade on surface open/close; `useReducedMotion` honored.
- Sidebar: fixed 22rem at xl; overlay (`absolute inset-3`) below xl with slide/fade.
- Footer: centered control bar.

### 1.8 Control bar (`SessionControlBar`)
- "Enable audio" button appears when browser blocks autoplay audio (`useStartAudio`).
- Mic toggle: pending spinner, off state styled destructive, aria-label swaps.
- Transcript panel toggle.
- END SESSION (destructive, mono label) → AlertDialog confirm ("transcript and feedback will be saved").

### 1.9 Sidebar (`SessionSidebar`)
- Tabs: **Transcript** (message bubbles You/Trainer, autoscroll, empty + preparing states, topic-coverage badges footer) and **Chat** (LiveKit `<Chat>`).
- Close button.

### 1.10 Participant tiles
- **AgentTile**: `useVoiceAssistant` state → connecting/thinking/listening/speaking; `useTrackVolume` level → `VisualizerBar` (bar count 5 / 3 compact); avatar (`vasanth.png` for vasanth, generic user icon otherwise); name + state label bottom-left; compact mode (48px avatar).
- **CandidateTile**: mic on/off icon, volume bars, "You" pill, compact mode.

### 1.11 Agent-driven surfaces (via `LiveKitWorkspaceProvider`)
- RPC methods: `workspace.code`, `workspace.canvas`/`workspace.whiteboard` (alias), `workspace.presentation`, `workspace.surface` + `surface`, `session.end` — all guarded to `ParticipantKind.AGENT`.
- Surface events also arrive as data packets (`parseAgentSurfaceEvent`).
- Surface renderers: `CodeEditor` (language, starterCode), `Whiteboard`, `PdfViewerSurface` (sourceUrl + `sessionId=` param injection, initialPage, title from context list), `ImageViewerSurface`, `PresentationViewer`.
- 2.5s waiter for handler registration; keyed remount per surface.
- `session.end` → same as manual end (completed).

### 1.12 Known cruft (opportunistic cleanup)
- `session/transcript-panel.tsx` — dead code, imported nowhere. Delete.
- `PreJoinHeader` duplicates the live header — consolidate.
- `playground-rounded` CSS block is LiveKit-defaults styling — check if still needed after restyle.

---

## Part 2 — Design plan (from the reference image)

*Every region of the screenshot mapped to a TrainerTwin equivalent. Dropped features listed explicitly.*

### 2.1 Visual language
- Dark studio canvas: page background near-black (`#141517`-ish), content cards one step lighter (`#1e2023`), hairline borders (`white/6–8%`), generous **16–20px card radius** (current: mixed 12–16px).
- Floating-card feel: the live stage is one rounded "app canvas" with internal sections separated by spacing + hairlines (no hard full-width header/footer bands like today).
- Pills everywhere: name pills, status pills, timer chip — full-rounded, subtle background.
- Mono digits for the timer (tabular-nums), like Riverside's `00:09:41`.
- Keep existing brand tokens for accents (primary color for active states, emerald for ready/covered, red for end/destructive).
- Dark-only (current site is dark; no light mode work).

### 2.2 Layout skeleton (live session)

```
┌────────────────────────────────────────────────────────────────┐
│ TopBar  logo  [scenario pill · persona]  [REC ● 00:12:41]   N  │
├──────────────────────────────────────────┬─────────────────────┤
│                                          │ ‹  Chat         (12)│
│   ┌──────────────┐  ┌──────────────┐     │  ┌───────────────┐  │
│   │              │  │   (surface   │     │  │ Recording card│  │
│   │  AgentTile   │  │    when open)│     │  │ 00:12:41      │  │
│   │  (large)     │  │              │     │  ├───────────────┤  │
│   │              │  │              │     │  │ chat / stream │  │
│   └──────────────┘  └──────────────┘     │  │  messages     │  │
│   ┌──────────────┐                       │  │               │  │
│   │ CandidateTile│                       │  └───────────────┘  │
│   └──────────────┘                        │                     │
│      ⚙  🎙  💬        🔴(end)              │                     │
└──────────────────────────────────────────┴─────────────────────┘
```

- **Top bar**: brand wordmark left; pill with scenario name + persona; right side: red `REC` pill with elapsed timer (recording is always on — this replaces Riverside's Live badge) and the user avatar.
- **Main area**: participant area (left, flex-1) + sidebar (right, ~360px).
- **Sidebar**: collapse chevron on its left edge (Riverside's `‹`), tabs — **Chat only** (see 2.5), content sections as rounded cards.
- **Control bar**: floating centered cluster of circular icon buttons at the bottom of the main area (not a full-width footer band): settings-like area (mic), chat toggle, and a separated red circular end button on the right of the cluster.

### 2.3 Participant tiles (restyle, keep behavior)
- Tiles become **rounded cards** filling the stage area (like the video frames), slightly lighter than the canvas, 1px hairline border, no heavy drop shadow.
- **AgentTile**: avatar (vasanth.png or generic) rendered *large inside the card* (not a small floating circle) with the voice bars overlaid near the bottom or around the avatar; name pill bottom-left (`Vasanth ●`) with the state dot (green speaking / amber thinking / gray connecting); state text optionally inside the pill.
- **CandidateTile**: same card style; centered mic glyph (or large avatar circle) like Riverside's audio-only tile; name pill "You ●"; muted state = red pill dot + MicOff.
- Surface-open compact mode keeps the same data-attribute behavior but restyled as small cards in the 7rem strip (avatar circle + 3 bars + name pill).

### 2.4 Sidebar (replaces today's SessionSidebar)
- **Tabs: Chat only.** The Participants tab from the reference is **not built**. The existing Transcript tab stays as a tab (chat + transcript are different data sources; transcript + coverage badges carry evidence state). Tabs = `Chat`, `Transcript` — restyled as text tabs with underline (Riverside-style), unread-count badge on Chat optional (skip v1).
- **Recording card** (top of sidebar): session/scenario name + big mono elapsed timer, `Recording` status dot; below it two rows: trainer ("Audio · live") and you ("Audio · live/muted") — replaces Riverside's per-participant upload rows (we don't have per-participant uploads; recording is server-side).
- **Coverage card** (transcript tab): topic badges restyled as compact chips inside a rounded card ("Topic coverage" header) — keep existing covered/secondary variants.
- Collapse behavior: chevron collapses the sidebar to a thin rail; below xl the sidebar becomes an overlay as today.

### 2.5 Chat panel
- Keep LiveKit `<Chat>` for now (agent ↔ user text chat works through it) but **reskin via CSS** (`.playground-rounded`-style overrides): rounded entries, transparent panel background, hairline input.
- If LiveKit chat styling fights the design, replace with a thin custom chat UI reading the same `RoomEvent`/`Chat` datastore — decision deferred to implementation; contract unchanged (same DataPacket kind Reliable chat protocol).

### 2.6 Control bar (replaces SessionControlBar visuals)
- Circular icon buttons (44–48px, hairline border, subtle bg): mic (pending spinner, destructive styling when muted), chat/sidebar toggle, enable-audio (conditional).
- **Red circular end button** (PhoneOff icon), separated to the right of the cluster — replaces the pill "END SESSION" button. AlertDialog confirm stays.
- Timer/REC chip lives in the top bar now; remove from the control area.

### 2.7 Other states in the same language
- **Configure card**: same card style — rounded 20px, dark canvas centered, pill-style select, chips; header simplifies to brand + "Disconnected" pill.
- **End screen**: centered card in the same canvas style; buttons keep existing actions (View sessions / New session).
- **Error overlay**: same, restyled backdrop-blur card.
- **Intro video**: fills the agent tile card (rounded corners, name pill overlay) — behavior unchanged.

### 2.8 Dropped from the reference (not applicable)
- Participants tab (per user), waiting room / admit (no multi-party), per-participant upload MB rows (recording is server-side), Director layout picker (single scenario layout; surfaces replace it), screen-share/camera buttons (voice-only session), live-viewer count badge.

### 2.9 Responsive
- ≥1280px (xl): sidebar docked right (~360px); tiles in main area.
- <1280px: sidebar overlays with slide-in; tiles full width; control bar stays centered.
- Mobile: tiles stack vertically (agent above you), surface opens full-screen with the compact strip, control bar remains reachable.

### 2.10 Motion
- Keep the spring layout language (stiffness ~300, damping ~32) for tile/surface transitions; keep `useReducedMotion` fallbacks. Subtle fade/slide for sidebar.

---

## Part 3 — Implementation plan

**Rule: visual restyle only.** The `SessionView` state machine, room lifecycle, data-packet handling, finalize flow, and all agent RPC contracts stay byte-for-byte in behavior. Layout JSX and styling change; logic hooks stay.

### Files
| File | Change |
|---|---|
| `components/session-view.tsx` | Live-stage JSX + header/footer restyle; extract `PreJoinHeader` duplication; configure card restyle; end screen restyle |
| `components/session/agent-tile.tsx` | Card-style tile, large avatar, name pill restyle |
| `components/session/candidate-tile.tsx` | Card-style tile, centered mic, pill restyle |
| `components/session/session-sidebar.tsx` | Rebuild: Chat-only tabs + recording card + coverage card restyle |
| `components/session/session-control-bar.tsx` | Circular floating cluster + red circular end button (confirm dialog kept) |
| `components/session/visualizer-bar.tsx` | Size/spacing tweaks if needed |
| `app/globals.css` | Replace `.session-*` / `.interview-*` blocks with new tokens; prune `.playground-rounded` if obsolete |
| `components/session/transcript-panel.tsx` | **Delete** (dead code) |

Not touched: `lib/livekit-workspaces.tsx`, surface components, API routes, agent, styles beyond the listed CSS.

### Steps
1. Tokens + stage skeleton in `globals.css` (canvas, card, pill primitives).
2. Tiles (agent + candidate) restyle.
3. Control bar + header restyle.
4. Sidebar rebuild (Chat-only + recording card).
5. Configure / end / error screens restyle.
6. Delete `transcript-panel.tsx`; prune dead CSS.
7. Verify checklist below.

### Verification
- [ ] `bun test` unchanged-green (no logic files touched — sanity run)
- [ ] `bun run lint` + `next build` clean
- [ ] Manual: configure → start → intro → live → surface open/close → chat send → end (manual + confirm) → end screen → new session; compare feature-by-feature against Part 1 inventory
- [ ] Live E2E voice session on the deployed preview: agent greeting, mic, transcript entries, coverage badges, agent-driven surface (code editor), session end + finalize
- [ ] `autoStart` portal path (`/session/[agent]`) still auto-starts with intro video
- [ ] Reduced-motion + mobile-width sanity check

### Open questions (defaults chosen; override freely)
1. **Transcript tab** — kept alongside Chat (only Participants dropped, per instruction). If you want Chat *only* with transcript merged into it or removed entirely, say so.
2. **Top-right avatar** — show the signed-in user's initials/avatar (needs session user data in the client) or keep the static logo mark.
3. **Unread badge on Chat tab** — skip in v1 (default).
