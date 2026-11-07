# Workspace tools per agent (role play and twin): a Tools tab and per-session loading

Status: built 4 Nov (uncommitted). Spike + full build verified (tests, eve build, live role-play sessions).

## Requirement

- Four toggleable workspace surfaces, each bringing its own tools:
  | Toggle | Surface actions | Tools |
  |---|---|---|
  | **Canvas** | `open_whiteboard` | `add_canvas_component`, `clear_canvas`, `highlight_canvas_element`, `highlight_whiteboard`, `read_canvas_scene` |
  | **Code editor** | `open_code_editor` | `get_code_state`, `read_code_range`, `highlight_code`, `run_code` |
  | **Preview** (PDF for now) | `open_pdf`, `highlight_pdf`, `highlight_document` | — |
  | **Multiple choice** | `open_choice` | `get_choice_state`, `highlight_choice` |
- Always available, no toggle: `read_document`, `close_surface` (when any surface is on), `finish_session`, and the non-workspace tools.
- Image and slides code stays in the codebase but is not offered (no toggle, not loaded).
- Saved per agent like the before/during settings. Backend is the same for role plays and twins; **only role plays show the
  Tools tab**.
- No `tools` setting saved = **all off** (role plays and twins).
- Out of scope: `/dash/agents` (v1 workspace).

## What exists (verified 4 Nov)

- Tools are static files in `chat/agent/tools/` (eve registers every file). All workspace tools run through
  `executeWorkspaceTool` (`chat/agent/lib/workspace-tools.ts`), which `roleplayGuard` turns into a no-op for client role
  plays; `read_document` has its own guard. The role-play prompt also says "Call no tool except end_call and
  scenario_examples" (`chat/agent/lib/roleplay.ts`).
- `surface` takes a free-text `action`; the browser understands `open_code_editor`, `open_whiteboard`, `open_choice`,
  `open_pdf`, `open_image`, `open_presentation`, `close_surface` (+ highlights) (`web/lib/agent-surface-events.ts`).
- A running session reads the agent's data from its start-time snapshot (`web/lib/session-context.ts:124`), so a toggle
  never changes a call in progress.
- Instructions are already resolved per session (`chat/agent/instructions/session-spec.ts`, `session.started`); role
  plays and twins get a lean core without the interview workspace section (`chat/agent/lib/base-instructions.ts`).
- eve has no per-step filter for static tools, but supports **dynamic tools**: a `defineDynamic` resolver at
  `session.started` returns only the tools a session gets; omitted tools are not in the model's tool list
  (`chat/node_modules/eve/docs/guides/dynamic-capabilities.md`). Constraints: `defineTool` written inline in an authored
  module, schemas inline or module-level (not captured from a resolver/helper variable), closures JSON-serializable,
  resolvers idempotent (they re-run on recovery).
- `transportTool(description, inputSchema)` builds each tool from parameters: that capture is exactly what eve rejects
  for dynamic tools, so definitions need restructuring.
- Role plays already render every surface (`SessionView`, `/s/<code>`); twin calls on `/t/` ignore surfaces
  (`CalibrationCall` `onSurface={ignoreSurface}`) — not in scope (no twin UI).

## Design

### Data
`Agent.data.tools = { canvas: boolean; codeEditor: boolean; preview: boolean; choice: boolean }`. Missing or partial →
`false`. One parser per package (`web/lib/agent-tools.ts`, `chat/agent/lib/agent-tools.ts`; chat doesn't import
`shared/`), each tested.

### Web
1. `components/roleplay/roleplay-builder-page.tsx`: a **Tools** tab; four `SwitchToggle` rows with a one-line
   description each, saved with the role play like the Learner setup rows.
2. `lib/roleplay/trpc.ts`: `tools` in the builder load and save input (zod, strict); saved to `data.tools`.
3. No session-screen change for role plays. Twins: no UI; the backend reads `data.tools` the same way.

### Chat agent
1. **Load tools per session** — `agent/tools/workspace.ts`: `defineDynamic({ events: { "session.started" } })` reads the
   session context (cached `getSessionContext`, already fetched by `session-spec`), parses `data.tools` and returns a map
   of only the enabled tools, keeping today's tool names. `surface` is returned when any surface is on; its description
   lists only the enabled actions plus `close_surface`.
2. **Restructure the 17 workspace tool definitions** out of `agent/tools/` (so eve no longer registers them statically)
   into `agent/lib/workspace/`: inline `defineTool`, module-level schemas, shared `executeWorkspaceTool` as the executor.
   Behaviour unchanged.
3. **Backstop guard**: `executeWorkspaceTool` checks the session's tool settings (action level for `surface`) and returns
   the "not available" result for anything not enabled — covers replays and recovery. Replaces the role-play-wide guard.
   `read_document`: guard removed (always available).
4. **Prompt**: in role-play and twin sessions, a short "WORKSPACE FOR THIS CALL" block listing only the enabled tools with
   1–2 lines of role-play guidance each; replace "Call no tool except end_call and scenario_examples…" accordingly. With
   nothing enabled, today's wording stays.
5. Python voice agent: unchanged (the browser runs the commands).

### Tests
- Parsers (web and chat): defaults, partial data, strict input.
- Resolver: enabled set → exact tool names; none → no workspace tools; `surface` description lists only enabled actions.
- Guard: action/tool mapping; `close_surface` allowed when any surface is on; unknown `surface` actions refused.
- Prompt block: some tools on vs all off (today's wording).
- Existing workspace tool tests keep passing (behaviour unchanged).

## Spike result (4 Nov) — dynamic tools work
- `chat/agent/tools/workspace.ts` (`defineDynamic`, `session.started`) + `chat/agent/lib/agent-tools.ts` (parser, cached
  per-session lookup via studio `getSessionContext`); static `chat/agent/tools/run_code.ts` removed.
- `eve info`: 0 errors/warnings, 27 static tools (run_code no longer static). `eve build`: passes; compiled manifest lists
  `tools/workspace.ts` under `dynamicTools` (`session.started`).
- Unit tests (`chat/tests/agent/lib/agent-tools.test.ts`): code editor on → exactly `run_code`; off / no settings / failed
  lookup → no workspace tools.
- Live, real chat-mode sessions on `eve dev`: code editor **on** → the model called `run_code` (brain-trace
  `tools_executed: run_code`); **off** → "NO RUN_CODE TOOL", nothing executed.
- Cold restart (`eve dev --resume`): the existing session kept `run_code` and called it again (rebind works). Note: plain
  `eve dev` restarts drop in-flight dev conversations (eve dev behaviour, not ours).
- Pattern that works: `defineTool({ description: "...", inputSchema: <module-level schema>, execute: executeWorkspaceTool })`.

## Build order
0. **Spike (½ day):** convert one tool (`run_code`) to the dynamic resolver; confirm in `eve dev` that it appears only
   when enabled, survives a recovery rebind, and keeps its callbacks. If eve's durable-callback rules block the
   conversion, fall back to static tools + guard + prompt (tools still visible to the model but inert and unmentioned).
1. Data parsers + Tools tab + save path (web).
2. Restructure the tool definitions; dynamic resolver; backstop guard; `read_document` always on.
3. Prompt block.
4. Tests; manual check of a role play with each toggle; check the role-play layout with a surface open next to the
   screen-share prompt.

## Risks
- **Interview-style role plays** (no `skill`; e.g. careerwithvasanth's résumé/system-design agents in prod) use these
  tools today; with "no setting = all off" they lose them until someone saves their Tools settings. Decided 4 Nov: out of
  scope (`/dash/agents` ignored).
- Every session's tool list now comes from the resolver: a resolver failure must fall back to "no workspace tools", never
  break the session.
- Prompt-cache: the tool list is fixed per session (resolved at `session.started`), so caching is unaffected mid-call.
