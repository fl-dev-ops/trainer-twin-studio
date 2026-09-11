# Issue 4: `/api/v1/chat/completions` Pipeline Stabilization

## 1. Context & Objectives
Stabilize, document, and test the `/api/v1/chat/completions` route in `@web`. Ensure it adheres strictly to OpenAI API specifications expected by LiveKit’s `livekit.plugins.openai` client, correctly streams responses, advances state, and captures telemetry/token usage.

---

## 2. Progress & Completed Implementations

1. **Startup Environment Validation (Commit `1ac3cc6`)**
   - Implemented `@t3-oss/env-nextjs` in `web/env.ts` to validate required server environment variables on Next.js boot:
     - `DATABASE_URL` (Neon PostgreSQL)
     - `OPENROUTER_API_KEY`
     - `OPENROUTER_BASE_URL`
     - `INTERVIEW_LLM_MODEL`
     - `NEXT_PUBLIC_BASE_DOMAIN`
   - `next.config.ts` imports `web/env.ts` to fail fast at build and dev startup if keys are missing.
   - `web/lib/runtime/openai.ts` refactored to read validated `env` instead of ad-hoc fallback chains.

---

## 3. Detailed Architectural Specification of `/api/v1/chat/completions`

The endpoint acts as a stateful, interview-aware LLM proxy implementing the OpenAI Chat Completions streaming protocol.

```text
LiveKit Agent (openai.LLM)
       │
       ▼ POST /api/v1/chat/completions (Bearer <runtimeToken>)
┌───────────────────────────────────────────────────────────┐
│ 1. Authentication & Session Resolution                    │
│    - Compute sha256(runtimeToken)                         │
│    - Lookup active InterviewSession record in Neon        │
│    - Reject if token null or session ended (HTTP 401)     │
├───────────────────────────────────────────────────────────┤
│ 2. Idempotency Check                                      │
│    - Hash incoming messages payload                       │
│    - If identical to lastCompletion.hash, replay SSE      │
│      chunks without re-grading or spending probe budget   │
├───────────────────────────────────────────────────────────┤
│ 3. Runtime Controller Hydration                           │
│    - Hydrate interview state from compiledSnapshot:       │
│      stages, guidelines, hidden facts, persona voice      │
│    - Hydrate runtimeState: current stage, active phase,   │
│      probe counts, topic coverage map                     │
├───────────────────────────────────────────────────────────┤
│ 4. Evaluation & Action Selection                          │
│    - Evaluate candidate's spoken response                 │
│    - Update evidence and topic coverage                   │
│    - Advance interview stage when phase criteria met      │
│    - Select next action: probe, clarify, challenge, wrap  │
├───────────────────────────────────────────────────────────┤
│ 5. In-Voice Persona Speech Synthesis                      │
│    - Retrieve nearest persona moment guidance             │
│    - Synthesize spoken question in persona tone           │
│    - Block director-note / rubric leaks                   │
├───────────────────────────────────────────────────────────┤
│ 6. OpenAI Streaming Emittance                             │
│    - Stream SSE chunks: choices[0].delta.content          │
│    - Emit tool calls if workspace surface required        │
│    - Emit usage tokens in final chunk                     │
│    - Terminate stream with data: [DONE]                   │
├───────────────────────────────────────────────────────────┤
│ 7. State Persistence                                      │
│    - Atomically update InterviewSession in database:      │
│      runtimeState, evidence, lastCompletion, revision     │
└───────────────────────────────────────────────────────────┘
```

---

## 4. OpenAI Protocol & LiveKit Compatibility Contract

To maintain seamless compatibility with LiveKit's `openai.LLM` plugin, the route must strictly satisfy:

1. **Chunk Format (SSE):**
   ```text
   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1741738000,"model":"trainertwin-runtime","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1741738000,"model":"trainertwin-runtime","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":18,"total_tokens":138}}

   data: [DONE]
   ```

2. **Tool Calls Format (When Surface Dispatched):**
   ```text
   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"workspace_surface","arguments":"{\"tool\":\"code\"}"}}]},"finish_reason":null}]}
   ```

3. **Standard Error Schema:**
   All 4xx / 5xx errors must follow the OpenAI API error structure:
   ```json
   {
     "error": {
       "message": "Unauthorized: Invalid or expired session token",
       "type": "invalid_request_error",
       "code": "invalid_api_key"
     }
   }
   ```

---

## 5. Verification Checklist (Definition of Done)

### Environment & Startup
- [x] `@t3-oss/env-nextjs` validates `DATABASE_URL`, `OPENROUTER_API_KEY`, etc. at startup.
- [x] Missing web environment keys immediately stop the server with clear schema errors.

### Protocol Compliance & Streaming
- [ ] Automated contract test validates that `/api/v1/chat/completions` output parses cleanly with official `openai` Node and Python SDKs.
- [ ] SSE chunks contain valid `id`, `object="chat.completion.chunk"`, and incremental `delta.content`.
- [ ] Final chunk includes `usage` object with non-zero `prompt_tokens`, `completion_tokens`, and `total_tokens`.
- [ ] Stream concludes with exact `data: [DONE]\n\n` delimiter.

### Runtime State & Resilience
- [ ] Idempotent request replay: identical turn request receives cached response without advancing probe counter.
- [ ] Active session state persisted to PostgreSQL Neon (`runtimeState`, `evidence`, `runtimeRevision`).
- [ ] Validated against LiveKit Python agent worker (`TrainerAgent.generate_reply()`).
