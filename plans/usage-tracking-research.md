# Usage tracking research: when and how each layer reports usage

Scope: LLM tokens + STT/TTS seconds, captured live (not only at session end).
Sources: installed packages (authoritative for our versions) + two live probes against Vercel AI Gateway.

| Layer | Version in repo | Where |
|---|---|---|
| LiveKit Agents (Python) | `livekit-agents` 1.6.6, `livekit-plugins-deepgram` 1.6.6, sarvam plugin | `agent/` |
| eve | 0.82.0 | `chat/`, `copilot/` |
| AI SDK | `ai` 7.0.148, `@ai-sdk/gateway` 4.0.121 | `chat/`, `copilot/`, `web/` |
| Vercel AI Gateway REST | OpenAI-compatible `/v1/chat/completions` | raw `fetch` in `web/lib/*` |

Correction to earlier plan: the voice agent's LLM is the **chat service (eve)** (`LLM_BASE_URL=https://chat.trainertwin.com/v1`), not the web runtime. So voice LLM tokens are counted in `chat/`, and the agent must drop its own LLM usage entries.

---

## 1. LiveKit Agents 1.6.6

### Events
- `session_usage_updated` → `SessionUsageUpdatedEvent { usage: AgentSessionUsage, created_at }`.
  Fired from `AgentActivity._on_metrics_collected` on **every** STT/TTS/LLM metric. `usage` is **cumulative since `session.start()`** (collector is reset on start).
- `session.usage` property: same cumulative snapshot on demand (use it in `on_session_end` for a final post).
- `metrics_collected` still fires but logs a deprecation warning; use `session_usage_updated`.

### When each component reports
| Component | Our impl | Fires | Quantity | Gotchas |
|---|---|---|---|---|
| STT | `deepgram.STTv2` (`flux-general-en`) | `RECOGNITION_USAGE` every **≥5 s wall-clock** while audio is pushed, plus a flush when the stream ends (`PeriodicCollector(duration=5.0)`) | `audio_duration` = seconds of audio **sent to Deepgram** (includes silence) | STT seconds ≈ connected time while mic is enabled |
| TTS | `sarvam.TTS` (`bulbul:v3`), streaming → returned as-is by `with_idle_sentence_flush` | One `TTSMetrics` **per spoken segment** when its synthesis finishes | `characters_count = len(segment_text)`, `audio_duration` = generated audio | Characters = full segment text even if the learner interrupts. No metric if the attempt errored |
| LLM | `openai.LLM(base_url=chat bridge)` | One `LLMMetrics` per LLM stream, at stream end | tokens from the final SSE `usage` chunk | `provider` = base-URL host (`chat.trainertwin.com`). Skipped on error or abort before first token; interrupted turns often report 0. **Ignore. eve counts these.** |

Provider/model strings: Deepgram → `"Deepgram"/"flux-general-en"`, Sarvam → `"Sarvam"/"bulbul:v3"`.

### JSON (`[u.model_dump() for u in session.usage.model_usage]`)
```json
[
  { "type": "llm_usage", "provider": "chat.trainertwin.com", "model": "trainertwin-runtime",
    "input_tokens": 3120, "input_cached_tokens": 2048, "input_audio_tokens": 0, "input_cached_audio_tokens": 0,
    "input_text_tokens": 0, "input_cached_text_tokens": 0, "input_image_tokens": 0, "input_cached_image_tokens": 0,
    "output_tokens": 214, "output_audio_tokens": 0, "output_text_tokens": 0, "session_duration": 0.0 },
  { "type": "tts_usage", "provider": "Sarvam", "model": "bulbul:v3",
    "input_tokens": 0, "output_tokens": 0, "characters_count": 4210, "audio_duration": 153.6 },
  { "type": "stt_usage", "provider": "Deepgram", "model": "flux-general-en",
    "input_tokens": 0, "output_tokens": 0, "audio_duration": 132.4 }
]
```
(Also possible: `interruption_usage` / `eot_usage` with `total_requests`.)

### Settings to use
- `session.on("session_usage_updated")` → keep the latest snapshot in memory (no I/O in the handler).
- Background loop every ~10 s: if snapshot changed, POST running totals `{sessionId, streamId: ctx.job.id, seq, totals}`.
- `on_session_end`: one final POST from `session.usage`.
- Drop `llm_usage` entries whose provider is our chat host.
- Screen vision (`screen_feedback/vision.py`) runs its own `openai.LLM` **outside** the session, so it isn't in `session.usage`. Add its tokens to the same totals by hand.

---

## 2. eve 0.82 (chat, copilot)

### Where usage appears
| Hook | Granularity | Payload |
|---|---|---|
| `defineInstrumentation({ events: { "model.call.completed" } })` (file in `agent/instrumentation/*.ts`) | **per model call** (per step attempt) | `{ idempotencyKey, finishReason, responseModelId?, responseId?, scope{ sessionId, rootSessionId, turnId, stepIndex, attemptId, attemptIndex }, usage{ inputTokens?, outputTokens?, inputTokenDetails?{cacheReadTokens?, cacheWriteTokens?}, costUsd? } }` |
| `"model.call.started"` | per model call | `{ idempotencyKey, model{modelId, provider}, runtimeContext?, scope }`. Shares `idempotencyKey` with its terminal event |
| `"step.attempt.metadata"` | per attempt | `providerMetadata` (gateway `cost`, `generationId`, `routing`) |
| stream event `step.completed` | per step | `data.usage` (already read in `chat/agent/channels/openai-compat.ts`) |
| `turn.waiting`, `session.waiting/completed/failed` | running total for the eve session (incl. subagents) | `data.usage{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd? }`. **Compaction calls are excluded** |
| `limits.sessionUsage({ total, window })` | before each model call | used for caps, not tracking |

Normalized type (`TokenUsage`): `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd? }`. eve takes `costUsd` from `providerMetadata.gateway.cost`, so it's filled when the call goes through the Vercel gateway.

### Gotchas
- Lifecycle events carry **no auth**. Our InterviewSession id lives in `session.auth.current.attributes.sessionId`; eve's `scope.sessionId` is eve's own id (address-based). Get our ids via `otelIntegration({ runtimeContext })`. It already returns `trainertwin.session.id` in `chat/agent/instrumentation/langfuse.ts`; add `orgId`/`userId`. It shows up in `model.call.started.runtimeContext`; save it in `ctx.state`, read it back on `model.call.completed`.
- Barge-in/steer: the interrupted step still emits `step.completed` (`finishReason: "other"`) with whatever usage the provider returned. eve also notes the AI SDK **can omit the model terminal when an incomplete stream closes**, so expect a small undercount. Reconcile against the gateway.
- eve does **not** send gateway `user`/`tags`.
- Copilot principal is the org only (`orgId:secret` Basic auth from `web/app/api/eve/v1/[[...path]]/route.ts`). Add `userId` there to attribute copilot usage per user.

### Settings to use
- Add `agent/instrumentation/usage.ts` (chat + copilot): `model.call.started` → `ctx.state.set(runtimeContext ids)`; `model.call.completed` → POST increment with `idempotencyKey = event.idempotencyKey`.
- Don't use `session.waiting` totals as the ledger (they exclude compaction, and eve session ≠ our session). Use them only as a check.

---

## 3. AI SDK v7 (direct `generateText`/`streamText`/`embed` calls)

### Usage type
```ts
LanguageModelUsage = {
  inputTokens, inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens },
  outputTokens, outputTokenDetails: { textTokens, reasoningTokens },
  totalTokens, raw?: JSONObject   // provider-native usage
}
EmbeddingModelUsage = { tokens }
```

### Hooks and timing
| Hook | When | Usage |
|---|---|---|
| `onLanguageModelCallEnd` | each raw provider call | `usage` + `providerMetadata` |
| `onStepEnd` / `onStepFinish` | each step (tool loop) | step `usage` |
| `onEnd` / `onFinish` | whole call | `totalUsage` (all steps) + last-step `usage` |
| `onAbort` | aborted stream | no usage |
| `result.usage` vs `result.totalUsage` | after await | `usage` = **last step only**; use `totalUsage` |
| `embed` / `embedMany` | per call | `usage.tokens` |

`providerMetadata.gateway` (verified live): `{ routing{…}, cost, marketCost, surchargeCost, gatewayCost, inferenceCost, inputInferenceCost, outputInferenceCost, reportingTagWriteCost, generationId }`. **Cost values are strings.**

### Settings to use
- Record in `onEnd`/`onFinish` with `totalUsage`. For multi-step agents, use `onStepEnd` if per-step rows are wanted.
- Embeddings (`chat/agent/lib/style-search.ts`, knowledge): record `usage.tokens`.

---

## 4. Vercel AI Gateway REST (raw `fetch`)

Verified 2026-03 with `google/gemini-3.8-flash`.

### Non-streaming response
```json
{
  "id": "gen_01M5SCKSNJGPMCC1XP78QNTA9Y",
  "object": "chat.completion",
  "model": "google/gemini-3.8-flash",
  "usage": {
    "prompt_tokens": 2, "completion_tokens": 16, "total_tokens": 18,
    "cost": 0.0000615, "is_byok": false,
    "prompt_tokens_details": { "cached_tokens": 0, "audio_tokens": 0, "video_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 16, "image_tokens": 0 },
    "cache_creation_input_tokens": 0,
    "cost_details": { "upstream_inference_cost": null, "upstream_inference_prompt_cost": 0, "upstream_inference_completions_cost": 0 },
    "market_cost": 0.0000615, "surcharge_cost": 0.000075, "gateway_cost": 0.0001365, "reporting_tag_write_cost": 0.000075
  },
  "generationId": "gen_01M5SCKSNJGPMCC1XP78QNTA9Y"
}
```

### Streaming
- The **final chunk carries `usage`** (same shape) plus `choices[0].delta.provider_metadata.gateway` (cost fields as strings, `generationId`, `routing`). **No `stream_options.include_usage` needed** (verified with and without).

### Gotchas
- `completion_tokens` **includes** `reasoning_tokens` (16 of 16 above). Don't add them again.
- `generationId` can be looked up later (`gateway.getGenerationInfo({ id })` → `totalCost`, `promptTokens`, `completionTokens`, `reasoningTokens`, `cachedTokens`, …).
- **Reporting tags cost money.** `providerOptions.gateway.{user,tags}` or `ai-reporting-user` / `ai-reporting-tags` headers: $0.075 per 1k writes, one write per unique user/tag per request. Measured: user + 2 tags = **$0.000225 per request, ~27× the LLM cost of a tiny call**. Top-level `"user"` alone added no write cost (unverified whether it appears in reports).

### Settings to use
- Read `data.usage` from every response, and from the last chunk when streaming. Store `generationId` in `meta` for reconciliation.
- Do **not** tag every request. Our own ledger does attribution. If needed, send top-level `user` only.

---

## 5. What we capture, per source (feeds `UsageEvent`)

| Source | Trigger | Metrics | Idempotency key | Identity |
|---|---|---|---|---|
| LiveKit agent | ~10 s loop + `on_session_end` (running totals) | `stt_seconds`, `tts_characters`, `tts_seconds`, `connected_seconds`, vision tokens | `streamId(job.id):provider:model:metric` cursor | `sessionId` → DB lookup |
| chat (eve) | `model.call.completed` | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd` (ref) | eve `idempotencyKey` | `runtimeContext.sessionId` → DB lookup |
| copilot (eve) | `model.call.completed` | same | eve `idempotencyKey` | `orgId` + `userId` from web proxy |
| chat embeddings | after `embed()` | `embedding_tokens` | request id | sessionId |
| web raw fetch (report, synthesis, spec-gen, rerank, evaluate) | after response | tokens (+ `generationId`, cost ref) | `generationId` | sessionId or signed-in user |

Reconciliation: daily, compare our LLM totals against the gateway report or `getGenerationInfo`.

## Open items
- Confirm screen-vision `openai.LLM.with_openrouter` gets usage back once moved to the gateway.
- Confirm `runtimeContext` from `otelIntegration` reaches `model.call.started` for a `defineInstrumentation` file in the same app (code path: `n.instrumentation?.resolveRuntimeContext` → `prepareAttempt({ runtimeContext })`).
- Interrupted (barge-in) calls: measure the undercount vs gateway.
