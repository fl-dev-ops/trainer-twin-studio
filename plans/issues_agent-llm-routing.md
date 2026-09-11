# Issue 2: LiveKit Agent LLM Routing

## Context & Objectives
Ensure all agent LLM inference calls route through `@web/ /api/v1/chat/completions` using the per-session dynamic `runtimeToken`. Eliminate external OpenRouter fallbacks and enforce fail-fast startup checks.

---

## Decisions & Requirements

1. **Strict Web Runtime Routing (No OpenRouter Fallbacks)**
   - The agent LLM must strictly route requests to:
     ```text
     {LLM_BASE_URL}/chat/completions  ->  https://dash.trainertwin.com/api/v1/chat/completions
     ```
   - No fallback to OpenRouter directly if `{WEB_URL}` is unavailable. If the runtime cannot be reached or rejects the token, the agent must fail with a clear error.

2. **Model Identifier Contract**
   - Hardcode the LLM model identifier in the agent:
     ```python
     MODEL = "trainertwin-runtime"
     ```
   - Matches the OpenAI-compatible completion handler contract in `web/lib/runtime/openai.ts`.

3. **Dynamic Session Runtime Token**
   - `runtimeToken` must be extracted from the session metadata:
     ```python
     raw_meta = ctx.job.metadata or ctx.job.room.metadata or ctx.room.metadata
     metadata = parse_metadata(raw_meta)
     runtime_token = str(metadata.get("runtimeToken") or metadata.get("runtime_token") or "").strip()
     ```
   - Passed dynamically as `api_key=runtime_token` in `openai.LLM(..., api_key=runtime_token)` per job session.

4. **Mandatory Startup Environment Validation**
   - Before starting the LiveKit worker, run a strict startup environment check.
   - Required keys:
     - `LIVEKIT_URL`
     - `LIVEKIT_API_KEY`
     - `LIVEKIT_API_SECRET`
     - `LLM_BASE_URL` (or `WEB_URL`)
     - `DEEPGRAM_API_KEY`
     - `SARVAM_API_KEY` (if `TTS_PROVIDER=sarvam`)
     - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`
   - If any required variable is missing or empty, print an explicit list of missing variables and exit with a non-zero code immediately (`sys.exit(1)`).
   - Prevents downstream runtime null-checks and silent failures inside job sessions.

---

## Action Items

- [ ] Add `validate_startup_env()` in `agent/src/agent.py` executed before server boot.
- [ ] Hardcode `model="trainertwin-runtime"` in `agent/src/session.py`.
- [ ] Remove `os.getenv("LLM_API_KEY")` and OpenRouter fallbacks from `agent/src/session.py`.
- [ ] Ensure missing `runtimeToken` in `JobContext` immediately logs an error and rejects the session without attempting calls to `/api/v1`.
- [ ] Verify test session receives 200 OK responses from `/api/v1/chat/completions` using the dynamic bearer token.
