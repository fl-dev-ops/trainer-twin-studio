# Issue 4: `/api/v1/chat/completions` Pipeline Stabilization

## Context & Objectives
Stabilize, document, and test the `/api/v1/chat/completions` route in `@web`. Ensure it adheres strictly to OpenAI API specifications expected by LiveKit’s `livekit.plugins.openai` client, correctly streams responses, advances state, and captures telemetry/token usage.

---

## Decisions & Requirements

1. **Document Behavior & Logic**
   - Provide a clear, step-by-step specification of what happens inside `handleCompletions`:
     1. **Authentication:** Validates `Bearer <runtimeToken>` against `InterviewSession.runtimeTokenHash`.
     2. **State Hydration:** Loads session snapshot (`compiledSnapshot`), runtime state (`runtimeState`), and coverage.
     3. **Turn Processing:** Parses user message, evaluates communication intent (speech, clarification, pause), updates topic coverage.
     4. **Action Selection:** Selects next interview action (opening question, deep probe, challenge, wrap-up).
     5. **Speech Generation:** Synthesizes trainer speech conditioned on persona voice and retrieved knowledge moments.
     6. **Tool Emittance:** Emits workspace surface tool calls (`workspace.code`, `workspace.canvas`, etc.) when requested.
     7. **Streaming / SSE:** Streams standard OpenAI chat completion chunks (`delta`, `finish_reason`, `usage`).

2. **OpenAI Protocol Compliance**
   - Must match LiveKit's `openai.LLM` expectations:
     - Streaming chunks format: `data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."}}]}`, followed by `data: [DONE]`.
     - Non-streaming responses support: standard `chat.completion` object.
     - Role formats: `assistant`, `user`, `system`, `tool`.
     - Idempotency support: Cached response replay on repeated requests with identical hash.

3. **Telemetry & Token Usage Reporting**
   - Emit accurate `usage` object in final SSE chunk:
     ```json
     {
       "prompt_tokens": 120,
       "completion_tokens": 45,
       "total_tokens": 165
     }
     ```
   - Log latency, stage transitions, and prompt execution metrics for observability.

---

## Action Items

- [ ] Write architectural documentation for `web/lib/runtime/openai.ts` and runtime controller.
- [ ] Add unit and contract tests verifying LiveKit's `openai.LLM` compatibility (SSE format, chunk delimiters, delta payloads).
- [ ] Ensure final SSE chunk includes valid `usage` stats (`prompt_tokens`, `completion_tokens`, `total_tokens`).
- [ ] Verify tool call formatting and execution round-trips with LiveKit agent tools.
- [ ] Harden error responses with standard OpenAI error structure:
  ```json
  { "error": { "message": "...", "type": "...", "code": "..." } }
  ```
