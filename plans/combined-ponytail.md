# Combined plan (ponytail)

Web is an `OpenAILLMService` backend. Specs stay. Flows stay out. Prompts stay. Python `select_action` behavior is copied, not redesigned.

```text
Pipecat STT → OpenAILLMService → POST /api/llm/v1/chat/completions
                                    token → snapshot + state
                                    user text → retrieve → analyze → select_action → render
                                    tool results → reducer, no re-grade
                                 ← SSE (validated text XOR tool_calls)
               tool handlers (workspace / finish_session) → same POST
               TTS ← text only after validation
```

## Do

| | |
|---|---|
| Endpoint | `/api/llm/v1/chat/completions` — not public `/api/v1` |
| Auth | Bearer = runtime token. Unique index `runtimeTokenHash`. Token finds the session |
| Pipecat | Unmodified `OpenAILLMService`. Construct it once the token exists (connect payload or first `start-interview`). Do not poke `_client.api_key` |
| Snapshot | Compile + pin on **session activate**. Stop `getAgentConfigForAgent` from reading live rows |
| State | Columns on `InterviewSession`: `compiledSnapshot`, `runtimeState`, `runtimeRevision`, `lastCompletion` (hash+body). No `InterviewRuntimeTurn` table |
| Tools | Pipecat runs them. Web emits only advertised ∩ spec ∩ phase. Encoder supports N parallel calls; controller emits 1 until a real turn needs 2 |
| Stream | Buffer render → validate → one SSE content chunk. No passthrough into TTS |
| Open / close | Surfaces as tool_calls with **null content**, then speak. `finish_session` → closing text → existing `ClosingGate`. Never `EndWorkerFrame` in the handler |
| Disconnect | PATCH status + recording only. Do not upload agent transcript over Postgres |
| Knowledge | Fail-closed. Persona voice degrades. Call Chroma in-process, not via HTTP-to-self |
| Tests | Keep `test_interview.py`. Dump its cases to JSON. One Pipecat tool-loop test against `agent/.venv` before the TS port. One `interview-runtime-check.ts` |

## Don't (YAGNI)

Responses / WS / embeddings / audio / files / `/models`. Playground UI, diagnostics, fork/compare. Compile-at-publish. Per-phase `LLMSetToolsFrame`. Connection tickets. Delivery-aware evidence. Microservice. Prompt edits. `run_code` until `WorkspaceBridge.request` is wired.

## Ship in this order

1. **Protocol shell.** Fake engine. SSE + parallel `tool_calls` fragments + retries return the same body. Green against real `OpenAILLMService` in `agent/.venv`. Stop if this fails.

2. **Schema + compile-on-activate.** Unique token hash. Snapshot + state + revision + lastCompletion. `authorizeRuntimeSession` by token. Disconnect patch cannot clobber transcript.

3. **Port runtime, three files:** `compiler.ts`, `runtime.ts` (controller+analyze+render+prompts), `openai.ts`. Reuse `spec-draft-schema.ts` and existing OpenRouter/Chroma helpers. Fixture parity with Python. `ponytail: lastCompletion on the row; turn table if playground replay is needed.`

4. **Point the agent at it.** Replace `InterviewBrainProcessor`. Register surface + `finish_session` handlers. Opening = first completions call (developer/session-start message). Coverage: GET session snapshot after a turn (`session-view.tsx` + share-code host). Env `INTERVIEW_LLM=web` until canary, then delete `interview.py` / `runner.py`.

Text check = `curl` the same route. A page later if curl is annoying.

## One check that must fail if this is wrong

Unmodified Pipecat: user → two parallel tools → both results → spoken text, **and** a replayed identical POST does not grade twice.
