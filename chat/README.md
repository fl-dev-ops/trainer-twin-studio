# TrainerTwin Chat Agent — the conversational brain

An eve agent that IS the interview trainer's brain: persona-faithful conversation
logic, style retrieval, workspace tools, and session grounding live here. Transports
(LiveKit voice, chat UIs) are thin shells that relay messages and execute workspace
tool calls on the learner's screen.

## Architecture

```text
┌──────────────────┐   OpenAI chat-completions    ┌──────────────────────────┐
│ LiveKit transport │ ──POST /v1/chat/completions──▶│  THIS eve agent (brain)  │
│ (python, voice)   │ ◀─ SSE: text + tool_calls ─── │  move → style → speak    │
│ executes workspace│                               │                          │
│ tool calls (RPC)  │                               │ tools/search_style       │
└──────────────────┘                               │ tools/search_knowledge   │
                                                    │ tools/* (workspace, fwd) │
        ┌──────────── studio (web) ────────────────┴──────────────────────────┐
        │ /api/copilot/studio: readSpec, searchStyleEpisodes, searchKnowledge │
        └─────────────────────────────────────────────────────────────────────┘
```

- **The brain owns the conversation**: durable eve sessions hold the full history,
  session grounding (scenario objective, phases, persona) is resolved at session start
  from the studio specs (`agent/instructions/session-spec.ts`), and every turn follows
  move → style retrieval → single styled generation.
- **Transports own execution**: workspace tools (`surface`, `finish_session`, canvas,
  editor, presentation, `workspace_request`) are declared here with exact names/schemas
  but executed by the transport over LiveKit room RPC. Internal tools
  (`search_style`, `search_knowledge`) execute inside eve, calling the web studio.
- **Contract**: the brain answers like an OpenAI streaming chat-completions endpoint —
  text deltas, `tool_calls` for transport tools, a usage chunk at the end.

## The `/v1/chat/completions` bridge (`agent/channels/openai-compat.ts`)

Accepts an OpenAI chat-completions request and maps it onto a durable eve session:

- Address = `x-trainertwin-session-id` header (or the Bearer token). One address = one
  durable session with the full history; callers send only the latest message.
- `role: "tool"` messages are forwarded as `[TOOL RESULT]` user messages.
- `"session-start"` maps to `[OPENING]` (generate the session opening).
- Auth: `Basic base64(orgId:COPILOT_SERVICE_SECRET)` (same as the eve channel), or
  `Bearer <any>` + `x-trainertwin-org-id` header.
- Scenario/persona grounding: `x-trainertwin-agent-slug` + `x-trainertwin-persona-slug`
  headers (case-sensitive slugs, e.g. `Vasanth`).

```bash
SECRET=...; ORG=...; curl -N -X POST http://localhost:2001/v1/chat/completions \
  -H "Authorization: Basic $(printf "%s:%s" "$ORG" "$SECRET" | base64)" \
  -H "content-type: application/json" \
  -H "x-trainertwin-agent-slug: impact-quantification" \
  -H "x-trainertwin-persona-slug: Vasanth" \
  -H "x-trainertwin-session-id: <web-session-id>" \
  -d '{"messages":[{"role":"user","content":"session-start"}]}'
```

## Env

- `OPENROUTER_API_KEY` — the LLM (`CHAT_AGENT_MODEL`, default `openai/gpt-4.1-mini`)
- `COPILOT_SERVICE_SECRET` — authenticates to the web studio
- `STUDIO_URL` — web origin (default `http://localhost:3000`)
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` — export Eve agent,
  generation, usage, cost, and tool traces to Langfuse, grouped by TrainerTwin session.
  Private interview prompt and response bodies are not exported.

## Run

```bash
bun install && bunx eve dev   # http://localhost:2001
bunx tsc --noEmit             # typecheck
```

## What lives where

| Path | Role |
|---|---|
| `agent/agent.ts` | model wiring (OpenRouter) + session limits |
| `agent/instrumentation.ts` | Eve OpenTelemetry export to Langfuse |
| `agent/instructions.md` | trainer identity, move logic, persona fidelity, workspace conduct |
| `agent/instructions/session-spec.ts` | dynamic per-session grounding from studio specs |
| `agent/tools/search_style.ts` | trainer's real speech for the current move (studio) |
| `agent/tools/search_knowledge.ts` | domain references for factual grounding (studio) |
| `agent/tools/*.ts` (15 others) | transport-executed workspace tools (forwarded via bridge) |
| `agent/lib/brain.ts` | spec loading + session-spec formatting |
| `agent/lib/studio.ts` | studio HTTP bridge (auth + org principal) |
| `agent/lib/workspace-tools.ts` | factory for transport-executed tool declarations |
| `agent/lib/auth.ts` | shared studio principal parser (Basic org:secret) |
| `agent/channels/eve.ts` | eve HTTP channel auth (studio principal + local dev) |
| `agent/channels/openai-compat.ts` | OpenAI-compatible bridge for transports |

## Not wired yet (transport integration)

- The LiveKit python agent still points at `{WEB_URL}/api/v1` (the web runtime).
  Switching it to this brain = pointing `LLM_BASE_URL` at this eve deployment
  (`STUDIO_URL` equivalent) and sending the `x-trainertwin-*` headers — no client or
  UI changes needed; the browser RPC contract is unchanged.
- Workspace tool results executed by the browser come back through the normal
  chat-completions `role: "tool"` round trip.
