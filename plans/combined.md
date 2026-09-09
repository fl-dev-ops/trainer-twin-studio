# Combined plan: Web-hosted OpenAI interview runtime

No code yet. This merges `plans/plan 1.md` (protocol + durability) and `plans/plan 2.md` (concrete port). Plan 1 wins every architectural conflict. Plan 2 is used only for module boundaries and the tool/playground sketches.

## Locked decisions

| Decision | Choice |
|---|---|
| Protocol | OpenAI Chat Completions subset only |
| Endpoint | `/api/llm/v1/chat/completions` — **not** public `/api/v1` |
| Model | `trainertwin-runtime` |
| Auth | Session runtime token as Bearer. Token resolves the session. No `X-Session-ID`, no session id in `model` |
| Pipecat | Unmodified `OpenAILLMService`; `base_url` + `api_key` + `model` |
| Retrieval | Internal web call, never a Pipecat tool |
| Tools | Pipecat executes; web gates. Register the session superset once |
| Tool concurrency | **Protocol must support parallel `tool_calls`.** Controller may still emit one mutating tool. Honor `parallel_tool_calls: false` |
| Streaming | Wire-compatible SSE is mandatory. Buffer renderer output, validate, then emit. No fake word-splitting. No passthrough of unvalidated tokens into TTS |
| State | Postgres is authoritative. Agent SQLite goes away after cutover |
| Specs | Immutable compiled snapshot pinned at session start |
| Opening | First provider inference, deterministic, no analyzer |
| Closing | `finish_session` tool → closing text → existing `ClosingGate` audio drain. Never `EndWorkerFrame` inside the tool handler |
| Surfaces | Tool loop (open then speak), because one OpenAI choice is text **or** `tool_calls` |
| UI coverage | Fetch from web after a finalized turn. Do not stuff private fields into SSE |
| Text playground | Same endpoint, same tool loop |
| Prompts | Unchanged during the port |

Do not proceed to the TS runtime port until an **unchanged** `OpenAILLMService` from `agent/.venv` completes: user → provider → tool_call(s) → local handler(s), including a parallel pair → tool result(s) → provider → assistant text.

---

## Compatibility scope (both plans’ addenda, resolved)

`base_url` on `OpenAILLMService` only hits **HTTP `/v1/chat/completions`**. Pipecat 1.7 has separate clients for Responses HTTP, Responses WebSocket, STT, and TTS. Changing `base_url` does not redirect those.

| Item | Decision |
|---|---|
| Chat Completions `/chat/completions` | **Required.** Streaming + non-streaming, all `tool_choice` modes, function tools, usage, OpenAI errors, cancellation, idempotent retries |
| Parallel `tool_calls` | **Required in v1.** Multiple indexed calls, fragmented args per index, multiple `role=tool` results, grouped continuation, `parallel_tool_calls: false`, duplicate/cancel/partial-failure. Controller still sequences writes (`replace_code` then `run_code`); reads may fan out |
| Responses HTTP `/v1/responses` | **Not v1.** Only if you later switch to `OpenAIResponsesHttpLLMService`. Same runtime, second adapter |
| Responses WebSocket | **Not v1.** That is `OpenAIResponsesLLMService` (`ws_url`, `previous_response_id`, `response.cancel`, connection-local cache). Needs a persistent process, not a Vercel route |
| Embeddings / files / audio / images / batch | **Do not implement.** Chroma, Sarvam/AssemblyAI, and web uploads already cover these. Absence does not reduce Pipecat LLM/tool compatibility |
| `/v1/models` | **Skip.** Pipecat does not need it |
| Wire SSE | **Required.** `stream: true`, role/content/tool deltas, usage, finish reason, `[DONE]`. First chunk may be delayed |
| Upstream token passthrough into TTS | **Rejected.** Renderer validates max words, question count, leaked keys, role reversal, closing. TTS cannot unspeak. ~45-word cap makes buffer-then-emit acceptable. Plan 2’s “validate after, log only” drops the current fallback |
| Separate runtime microservice | **Not for Chat Completions.** Stay a Next.js Node route with `maxDuration`. Revisit only if Vercel 504s or Responses WebSocket is chosen |
| Prompt / grading changes | **Deferred until after parity.** Otherwise regressions cannot be attributed |
| Delivery-aware evidence | **Out of the OpenAI protocol.** HTTP success ≠ TTS played. After Postgres is authoritative, add a Pipecat → web delivery event (bot started/stopped/interrupted). Do not invent OpenAI fields for this |

Contract for v1: drop-in provider for **`OpenAILLMService`**, not the whole OpenAI family.

---

## What each plan got right

**From plan 1 (keep):** protocol-first; `/api/llm/v1`; token-only session; language-neutral fixtures from `test_interview.py`; compile-at-publish; pinned snapshot; logical turn vs HTTP request; request-hash idempotency; compare-and-swap; advertised ∩ spec ∩ phase tool gate; `webrtcRequestParams.requestData` so the LLM is constructed with the token; disconnect must not overwrite canonical transcript; playground as an OpenAI client; versioned controller/prompts; feature-flag rollout.

**From plan 2 (keep, stripped):** small `web/lib/interview-runtime/` layout; reuse `spec-draft-schema.ts`; call Chroma libraries directly; text playground; `WorkspaceBridge` handlers for surfaces and later `run_code`.

**From plan 2 (throw away):** `/api/v1/chat/completions`; `X-Session-ID`; Prisma `state` / `transcript.push` as if they exist; word-by-word `sleep(20)` SSE; **passthrough streaming with post-hoc validation**; `end_session` + `EndWorkerFrame` in the handler; mutating `llm._client.api_key` after pipeline boot; hardcoded `INTERVIEW_TOOLS` decided after render; matching tool results by id substring; deleting `test_interview.py` before fixtures exist; Vercel AI SDK `generateObject` as a silent prompt/SDK swap; `/v1/models`; treating Chat Completions `base_url` as if it also covered Responses/WebSocket.

---

## Target flow

```text
Browser audio
  → Pipecat VAD/STT/LLMUserAggregator
  → OpenAILLMService
  → POST /api/llm/v1/chat/completions
      → token → session + compiled snapshot
      → if new user text: retrieve → analyze → select_action
      → if tool result: apply reducer, do not re-grade
      → renderer text, or one-or-more tool_calls (never unvalidated TTS tokens)
  ← OpenAI SSE

tool_call(s) → Pipecat handlers (parallel if indexed together)
            → same endpoint again with all role=tool results
            → text → TTS

Opening (no learner text yet):
  surface needed? tool_call(s) first (no spoken content), then opening text
  else deterministic opening text

Closing:
  finish_session tool → closing text → ClosingGate → PATCH status/recording only
```

---

## Current code the plan must respect

- `bot.py` already has the stock turn spine. Custom piece is `InterviewBrainProcessor`.
- Retrieval already lives in web (`/api/agent-sessions/:id/search`). Knowledge failure **blocks grading**; persona voice degrades.
- Prisma `InterviewSession` has `transcript` / `evidence`, **not** controller state. `runtimeTokenHash` is not unique/indexed for token-only lookup. `authorizeRuntimeSession(id, token)` requires session id today.
- `getAgentConfigForAgent` loads **live** Agent/Persona/Domain rows, not the pinned `*Version` columns.
- Browser sends RTVI `start-interview {sessionId, runtimeToken}` after WebRTC connect (`session-view.tsx`). Coverage arrives as `interview-state`. Agent `PATCH /api/sessions` on disconnect currently sends transcript/evidence from Python memory.
- Surfaces open via `surface_for_phase` + `WorkspaceBridge.command`, not LLM tools. `WorkspaceBridge.request()` exists and is unused.
- `test_interview.py` is the real gate (compiler + live `InterviewSession`).
- Public `/api/v1/*` is the org integration API (`x-api-key`).
- Unrelated dirty files: `copilot/` firecrawl tools, `web/lib/firecrawl.ts`. Do not mix this migration with those.

---

## Phases

### 1. Freeze behavior

Convert `agent/test_interview.py` into JSON fixtures:

- compiled Persona/Agent/Domain
- initial state, learner input, stubbed analyzer output
- expected applied analysis, action, coverage, phase/probe, close reason

Cover: strong/partial evidence, invalid keys, non-verbatim quotes, clarifications that do not spend probes, stop, phase budget, resume grounding, hypothetical design, coding execution trust, contradictions, feedback phase, renderer fallback.

Record a few full Python sessions (fundamentals, system design, full mock, coding with mocked execution, interrupt, provider failure). Prose may drift after the port; classification, coverage, actions, phase, retrieval, close reason must not.

Acceptance: existing Python tests still pass. No policy changes.

### 2. OpenAI/Pipecat shell (no interview brain)

`web/app/api/llm/v1/chat/completions/route.ts` — parse, auth, call an injected engine, encode SSE/JSON, OpenAI-shaped errors.

Support the Pipecat subset: `model`, `messages`, `tools`, `tool_choice`, `stream: true`, `stream_options.include_usage`. Roles: `system`, `developer`, `user`, `assistant`, `tool`. Size limits on messages, tools, tool results.

SSE for text: role chunk → one content chunk → `finish_reason: stop` → usage → `[DONE]`.

SSE for tools: stable ids, `delta.tool_calls[index]` **fragments** per call (name, argument pieces), `finish_reason: tool_calls` → usage → `[DONE]`. Multiple indexes in one response. Honor `parallel_tool_calls: false` by emitting a single call.

Do not emit assistant `content` and `tool_calls` in the same choice for v1. Plan 2’s “speak a setup line + open two surfaces” makes TTS race the workspace. Surface/open first, speak on the continuation.

**Decisive test** against `agent/.venv` Pipecat: register handlers, provider returns **two** parallel tool calls, both run (`run_in_parallel=True`), both results return, provider returns text. Also: one call, split argument fragments, bad JSON args, missing handler, `tool_choice` none/required/named, `parallel_tool_calls: false`, cancellation of one call in a pair, async-tool developer messages.

Do not port `select_action` until this is green.

### 3. Snapshot, state, idempotency

**Compiler.** Extend `web/lib/spec-draft-schema.ts`; port `build_specs()` (deep-merge, stage ids, `<stage>.<key>` evidence, turn bounds, allowed/default actions, hidden scenario facts, Agent/Domain match, DB versions). Publish path must compile; drafts may be invalid; session activation uses only a compiled snapshot.

**Pin on activate** (not live rows): persona/agent/domain data+versions, resolved phases, qualified evidence, grounding rules, KB ids, rendering, prompt+controller+schema versions, upstream model, context identity/hash.

**Postgres (minimum, not a framework):**

- `InterviewSession`: `compiledSnapshot`, `runtimeState`, `runtimeRevision`, `controllerVersion`, unique index on `runtimeTokenHash`
- `InterviewRuntimeTurn`: logical turn (learner utterance → possibly several HTTP calls). Status: processing / awaiting_tool / completed / cancelled / failed. Analysis, action, retrieval, pending tool call **ids** (one or many), results, final response.
- Completion cache keyed by canonical request hash (session + model + messages + tools + tool_choice). Retries return identical content, tool-call ids, arguments, finish reason. Hash ignores `stream`.

Token-only auth: Bearer hash → exactly one assigned/active session.

Compare-and-swap on `runtimeRevision`. No long-lived DB transaction across model calls. Duplicate HTTP → cache. Second learner utterance is a new logical turn because preceding context differs. Tool continuations share the logical turn and **must not** re-run analyzer or increment `phase_turns`.

Abort/barge-in: cancel in-flight fetch; mark turn cancelled; do not commit a grade.

### 4. Port the runtime

```text
web/lib/interview-runtime/
  schema.ts
  compiler.ts
  controller.ts    # pure, from runner.py
  prompts.ts       # verbatim Python prompts
  model.ts         # same OpenRouter structured-output path as today
  runtime.ts
  openai.ts
```

Port pure functions first (`select_action`, validate/apply evidence, probes, phase expire, closing, render validation, fallback, retrieval-skip). Then analyzer (quote requirement, ≤2 updates, execution-result trust, claim provenance, retry-once, raw vs applied). Then retrieval via existing Chroma helpers — fail-closed for knowledge, degrade for persona voice. Then renderer: validate → one repair → fallback.

Tool policy:

```text
tools advertised by Pipecat
∩ tools allowed by compiled scenario
∩ tools allowed in current phase
```

Never emit an unadvertised or stage-forbidden tool. If the controller requires a surface/run/close tool, force that named call. Independent read-only inspections may be emitted together; mutating sequences stay ordered across HTTP rounds. `tool_choice: none` → text only. Conflict with required/named choice → OpenAI-shaped error. Honor `parallel_tool_calls: false`.

Tool results: match exact pending id+name; wait for the whole group before continuing; reject unknown/duplicate/expired/cancelled; typed reducer; no re-analysis. Partial failure: record the error result, do not invent a success, then decide text vs retry vs close.

Acceptance: golden fixtures match Python; recorded sessions match action/state; tools cannot bypass phase policy.

### 5. Pipecat becomes a stock client

Pass session id + runtime token in `SmallWebRTCTransport` `requestData` / `SmallWebRTCRunnerArguments.body` so `OpenAILLMService` is constructed with the real Bearer token. **Do not** mutate `llm._client.api_key` after boot. Redact tokens from Pipecat/FastAPI logs; if that is impossible, mint a one-time connection ticket.

Keep: VAD, SmartTurn, STT, TTS, aggregators, interruptions, recording, `WebRTCAudioOutputFilter`, `ClosingGate`, `WorkspaceBridge`, Sarvam `finalized` patch.

Replace `InterviewBrainProcessor` with `OpenAILLMService(base_url=$WEB_URL/api/llm/v1, api_key=token, model=trainertwin-runtime)`.

`agent/tools.py` — ordinary Pipecat handlers, always `result_callback()`:

- Surfaces: open code/whiteboard/pdf/presentation, close
- Workspace (when wired): editor state, run code, canvas, presentation nav — via `WorkspaceBridge.request`
- `finish_session`: mark closing, return result, **do not** end the worker

Closing sequence: provider `finish_session` → handler flags closing → provider returns closing text → `ClosingGate` wraps TTS → then finalize web session (status, recording). Disconnect finalizer may send audio metadata only; it must not replace transcript/evidence.

Register the trusted superset for that session once. No per-phase `LLMSetToolsFrame` until measured.

Browser: stop relying on RTVI `interview-state` as source of truth; after bot output, GET a session snapshot (coverage, phase, status). Keep RTVI for workspace.

Env flag: `legacy` | `web-openai`.

### 6. Playground, then cut over

Playground is an OpenAI client against the same route: preview session/token, pin published spec **or** a draft revision, run the tool loop, show a trainer-only diagnostic panel (raw/applied analysis, action, retrieval, tools, render validation, versions, latency).

v1 playground: reset + replay. Defer fork/compare/export until the voice path is canarying.

Rollout: nullable schema → endpoint with no prod traffic → conformance tests → compiler+runtime → playground → replay Python traces → canary one voice scenario → compare state/tools/latency → switch all → keep legacy one release → delete `interview.py` / `runner.py` and unused Python deps (Pydantic AI, Chroma, libSQL, YAML, local db).

---

## Missed by both plans

1. **Do not mix spoken content and `tool_calls` in one choice.** Coding stages today open the editor at `apply_surface(0)` *and* speak the opening. After the move the agent has no spec. First inference must emit surface `tool_calls` (parallel ok if several opens are independent), then return opening text on the continuation. Plan 2’s example of a setup sentence plus two tool_calls is protocol-legal and product-wrong: TTS will start before the workspace is ready.

2. **`getAgentConfigForAgent` ignores pinned versions.** Session stores `personaVersion` / `agentVersion` / `domainVersion` but config load reads current rows. Without the snapshot, a trainer save mid-session changes a live interview. Plan 1 names the snapshot; neither plan names this existing bug.

3. **Token lookup needs a unique index.** `runtimeTokenHash` is nullable, not unique. Token-only auth (plan 1) requires `@@unique` and a query that does not take session id. Today auth is `(id, token)`.

4. **Disconnect `PATCH /api/sessions` will wipe the new source of truth** if the agent still uploads its local transcript. After cutover that local transcript is empty or stale. Restrict the patch to status + recording.

5. **Browser contract is unspecified.** `session-view.tsx` uses RTVI `start-interview` and `interview-state`. Plan 1’s `requestData` path needs a web client change; plan 2’s post-hoc header mutation is fragile. Both missed the learner share-code host (`app/(org)/s/[code]`) which must send the same connect payload.

6. **Vercel/serverless vs 45s turns.** Analyze + Chroma + render already uses `AGENT_TURN_TIMEOUT_SECONDS=45`. Set `maxDuration` on the Node route. A separate microservice is **not** an OpenAI requirement; revisit only if this 504s in prod or if Responses WebSocket is chosen.

7. **Barge-in across HTTP.** Python cancels `step()` before SQLite commit. A remote provider must abort the upstream model/retrieval and not CAS-commit. Plan 1 mentions cancellation; neither specifies the client `AbortSignal` from Pipecat interruption → HTTP.

8. **Knowledge fail-closed vs empty hits.** `_references` raises; the answer is not graded. A “return []” port silently changes scoring.

9. **One HTTP call vs one learner turn.** `step()` can retrieve twice on phase change. Tool-result POSTs must not look at “latest user message” and grade again (plan 2’s skeleton does exactly that).

10. **`run_code` is not a live tool.** It is a controller action; the sandbox currently opens an editor. Do not advertise `run_code` until `WorkspaceBridge.request` is wired and execution results are the only trusted provenance.

11. **Opening through the provider needs an empty-user trigger.** Pipecat will not call the LLM until a user turn unless you enqueue a controlled developer/session-start message. Specify that message; do not also keep a side-channel `TTSSpeakFrame` (plan 2) or playground and voice will diverge.

12. **Playground auth.** Trainers must mint a runtime token for a preview session. Do not accept the dashboard Better Auth cookie on the OpenAI route, and do not accept org `x-api-key` there either.

13. **Host/org isolation.** Token → org → snapshot. Client must never pass KB names or `orgId`.

14. **Idempotent start.** `InterviewSession.start()` is already idempotent for the same id. The first completions request (opening) will be retried by networks; cache it or you greet twice.

15. **Observability.** Log `request_id`, session, logical turn, action, whether the POST was user vs tool. You cannot debug voice/text drift without this.

16. **Schema/controller version on active sessions.** A deploy mid-interview must read the previous state shape or drain. Plan 1 mentions it; it is not optional.

17. **Uncommitted firecrawl work.** Isolate before this branch.

18. **No `/models` route.** Public OpenAI clients may call it; Pipecat does not need it. Skip.

19. **Passthrough streaming is not “true OpenAI compatibility.”** Wire SSE is required; forwarding unvalidated renderer tokens into TTS is a safety regression. Keep buffer → validate → emit. Revisit sentence-level flush only if TTFB is measured bad *and* fallback still runs before any audio.

20. **Spec compiler (`spec-generation.ts`) is out of scope.** Runtime move does not require changing how trainers author specs.

21. **Delivery-aware evidence is not an OpenAI field.** After cutover, Pipecat should POST bot-started / bot-stopped / interrupted to the session control plane so a barged-off question is not treated as asked. Out of v1 protocol; not out of the product.

---

## Definition of done

- Unmodified Pipecat `OpenAILLMService` pointed at `/api/llm/v1` runs voice sessions.
- Tools execute in Pipecat; single and parallel `tool_calls` both work; results return to web; web owns assessment.
- Chroma, specs, prompts, controller state, decisions live only in web.
- Voice and text share the endpoint and produce the same action/state sequence.
- Sessions pin compiled snapshots; live spec edits cannot leak in.
- Retries cannot double-grade or mint new tool-call ids.
- Opening, surface-then-speak, interruptions, errors, closing audio, recording, reconnect have coverage.
- Postgres, not SQLite / RTVI / browser memory, is authoritative.
- Legacy Python runtime removed only after one flagged release.

## Deferred

- Responses HTTP / WebSocket (only if you pick those Pipecat services)
- Embeddings, files, audio, images, batch, `/models`
- Upstream token passthrough into TTS
- Prompt/policy edits (after parity)
- Playground fork/compare/export
- Per-phase `LLMSetToolsFrame`
- Separate runtime microservice (only if Vercel 504s or Responses WS)
- Delivery-aware evidence as a **control-plane** event after Postgres is canonical — not as extra OpenAI fields
