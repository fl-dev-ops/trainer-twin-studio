# Issue 6: OpenRouter Failure Policy for `/api/v1/chat/completions`

## Context

Every OpenRouter call inside the interview pipeline is currently wrapped in a
silent catch-and-fallback. When OpenRouter is down, rate-limited (429), slow, or
timing out, the session does not fail — it *limps*: interview state diverges from
reality, the trainer speaks templated filler, and no signal reaches the LiveKit
agent, the user, or telemetry. This issue defers the decision made during
Issue 4 stabilization and defines the failure policy properly.

**Status: deferred.** Created during Issue 4 implementation (all protocol
stabilization work — usage chunk, error envelope, telemetry, streaming contract
tests — is done and merged; this issue covers runtime *resilience policy* only).

---

## 1. Current behavior per stage (as of Issue 4 completion)

| Stage | On failure today | Silent consequence |
|---|---|---|
| Direction check (`runDirectionCheck`) | defaults to `{learner_intent: "answer", on_track: true, should_grade: true}` | **A confused learner gets graded**; an off-topic turn is treated as an answer. Interview state diverges from reality. |
| Analyzer (`runAnalyzerLLM`) | `classification: "unknown"` | Controller picks a conservative probe; acceptable, but evidence coverage never advances. |
| Content speech (`generateContentSpeech`) | `deterministicFallback(action)` — templated "Could you explain X in your own words?" | Candidate hears a robot; repeated blips turn every turn into a template. |
| Persona render (`renderPersonaSpeech`) | falls back to the content-speech draft | Persona voice identity silently lost. |
| Knowledge retrieval (`retrieveKnowledge`) | empty hits, session continues | Fine — auxiliary input. |
| Persona moments (`retrievePersonaMoments`) | empty hits, session continues | Fine — auxiliary input. |

Additional structural facts:

- `OPENROUTER_API_KEY` missing is **no longer a runtime concern** — `web/env.ts`
  (T3 env) validates it at startup; `callOpenRouter` has no missing-key path.
- A top-level try/catch already converts *unexpected* exceptions into
  OpenAI-structured `{error: {message, type, code}}` 500 responses.
- Aggregate telemetry exists: `[interview-runtime] completion served` logs
  sessionId, revision, turn type, latency, token totals, per-stage timings.
- **`callOpenRouter` has NO transport-level retry and NO fetch timeout** — a
  single 429/5xx/hang immediately degrades the stage or hangs the request.

## 2. The LiveKit constraint (hard latency budget)

Verified against `livekit-agents==1.6.6` (`livekit/agents/inference/llm.py`):
the agent's `openai.AsyncClient` uses `httpx.Timeout(connect=15, read=5,
write=5, pool=5)`, and our route performs **all 3–4 LLM calls before the first
SSE byte**. Therefore:

- If the OpenRouter pipeline exceeds ~5s end-to-end, the agent side raises
  `APITimeoutError` (`APIConnectionError`) and the turn dies anyway — regardless
  of what the route returns.
- "Hold the session open and wait out the outage" is not a viable strategy.
- Any failure policy must respect: **total pipeline time < agent read timeout
  (~5s)**. A per-request hard deadline (~4s) is part of any solution.

## 3. Options considered

### A — Status quo (document it)
Keep silent degradation; add stage-failure counters to telemetry so it is at
least visible. Zero behavior change, zero honesty about quality collapse.

### B — Pure fail-fast
Any stage failure → throw → top-level catch → OpenAI 503 → LiveKit raises
`APIStatusError` → agent job fails. Honest and consistent with Issue 2's
zero-fallback philosophy, but one transient 429 kills a live voice interview
mid-conversation. Too brittle for voice UX.

### C — Retry + severity-aware degradation (RECOMMENDED)
- `callOpenRouter` gains transport-level retries: 2 attempts, short backoff
  (e.g. 300ms), only for 429 / 5xx / network / timeout — never for 401/400
  (permanent errors).
- After the retry budget exhausts, degrade **by severity**:
  - **Speech stages** (content/persona): keep `deterministicFallback` + loud
    warn log. A templated question is recoverable; killing the session over it
    is worse.
  - **Direction / analysis** (the grading brain): propagate the failure →
    OpenAI error response → LiveKit decides. Dropping a turn beats grading
    fiction.
- Per-request hard deadline (~4s total) so the route fails before the agent's
  5s read timeout instead of hanging.

### D — C + session circuit breaker (later, if needed)
Track consecutive failures in `runtimeState`; after K consecutive broken
grading turns, return an error that ends the session cleanly instead of
limping indefinitely. ~20 lines on top of C; implement only if real sessions
show repeated limp-along behavior.

## 4. Sharp edges to fix within C

- The **direction-check fallback fabricates `should_grade: true`** — this is the
  single most dangerous silent path (grades a non-answer). It must either be
  removed (propagate) or changed to a non-grading default.
- The analyzer's `classification: "unknown"` fallback is reasonable and can stay
  (the controller already handles unknown).
- Speech fallbacks are fine to keep but must log a loud warning so
  sustained-degradation sessions are findable in logs.

## 5. Acceptance criteria (when implemented)

- [ ] `callOpenRouter` retries 429/5xx/network errors up to 2 attempts with
      backoff; permanent errors (401/400) fail immediately.
- [ ] Direction/analysis stage failures propagate as errors after retry budget;
      no fabricated `should_grade` state.
- [ ] Speech-stage failures degrade to `deterministicFallback` with a loud warn
      log including stage + attempt count.
- [ ] Hard per-request deadline (~4s) enforced across all OpenRouter calls.
- [ ] Telemetry distinguishes retry events, final degradations, and propagated
      failures (stage-failure counters in the `completion served` line).
- [ ] New tests: retry behavior (mocked fetch), severity routing, deadline
      enforcement; existing 27 runtime tests still pass.

## Related

- Issue 4: `plans/issues_chat-completions-stabilization.md` (protocol layer, done)
- Issue 2: agent-side strict routing and fail-fast env validation
