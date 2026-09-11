# Issue 2: LiveKit Agent LLM Routing & Verification

## 1. Context & Objectives
Ensure that all LLM inference in the LiveKit voice agent (`agent/src/agent.py`) routes strictly to `@web/ /api/v1/chat/completions` using the per-session dynamic `runtimeToken`. Eliminate external OpenRouter fallbacks from the agent worker, enforce startup environment validation, and verify the deployment end-to-end on the E2E Networks server using `e2e_cli`.

---

## 2. Architectural Decisions & Requirements

### A. Strict Web Runtime Routing (Zero Fallbacks)
- The agent's `openai.LLM` instance must point strictly to:
  ```text
  {LLM_BASE_URL}/chat/completions  ->  https://dash.trainertwin.com/api/v1/chat/completions
  ```
- **No direct OpenRouter fallback:** The agent must never call `openrouter.ai` directly. If the web runtime endpoint is unreachable or returns an error, the agent must fail immediately with an explicit error.

### B. Fixed Model Identifier Contract
- Hardcode the model string in `agent/src/session.py`:
  ```python
  DEFAULT_LLM_MODEL = "trainertwin-runtime"
  ```
- Do not read `LLM_MODEL` from environment variables. The web runtime controller (`web/lib/runtime/openai.ts`) intercepts this virtual model name and executes interview orchestration, persona speech conditioning, and tool emittance.

### C. Dynamic Runtime Token Authentication
- The session `runtimeToken` is generated per interview by `web/lib/interview-sessions.ts` and dispatched inside the LiveKit job metadata:
  ```python
  raw_meta = ctx.job.metadata or ctx.job.room.metadata or ctx.room.metadata
  metadata = parse_metadata(raw_meta)
  runtime_token = str(metadata.get("runtimeToken") or metadata.get("runtime_token") or "").strip()
  ```
- If `runtime_token` is missing or empty:
  - Log an error: `Runtime token missing from job metadata for session {session_id}`.
  - Abort the session immediately (`return` / reject job). Never attempt unauthenticated calls or use fallback tokens.
- Pass `runtime_token` as the `api_key` to `build_agent_session`:
  ```python
  session = build_agent_session(
      base_url=f"{WEB_URL}/api/v1",
      api_key=runtime_token,
      voice=voice,
  )
  ```

### D. Fail-Fast Startup Environment Check
Before starting the LiveKit worker, validate all required environment variables in `agent/src/agent.py`:
- If any required variable is missing or empty, print an explicit list of missing variables and exit with `sys.exit(1)`.
- Prevents runtime null checks and silent worker failures inside active jobs.

---

## 3. Environment Variables Reference

### Where to Find the Right Environment Values
- **LiveKit Cloud Credentials:** Found in `web/.env.prod` or `agent/.env` (Project Settings → Keys in [cloud.livekit.io](https://cloud.livekit.io)).
- **S3 & Storage:** Found in `web/.env.prod` under AWS section.
- **Sarvam TTS:** Found in `agent/.env` or 1Password developer vault.
- **Production Server Location:** Remote file on E2E VM at `/opt/trainertwin-agent/.env`.

### Canonical Environment Specification (`agent/.env` & Swarm `stack.yml`)
```env
# LiveKit Cloud
LIVEKIT_URL=wss://diagnosticpre-call-agent-tngt0emv.livekit.cloud
LIVEKIT_API_KEY=APIpDcXznRzcKCB
LIVEKIT_API_SECRET=<secret>
AGENT_NAME=intervoo-agent

# Web Runtime Routing
WEB_URL=https://dash.trainertwin.com
LLM_BASE_URL=https://dash.trainertwin.com/api/v1

# Speech & Voice (Sarvam)
TTS_PROVIDER=sarvam
SARVAM_API_KEY=sk_10d1wop5_9TOMAm4PTPtUkbYsqcN2c3i0
SARVAM_SPEAKER=rohan
DEEPGRAM_API_KEY=969eca8ba8db7ccf7013b10a68f95205e2f0c79c

# Recording & Storage (Always Enabled)
AWS_REGION=ap-south-1
AWS_S3_BUCKET=trainer-twin-prod
S3_BUCKET=trainer-twin-prod
AWS_ACCESS_KEY_ID=AKIA4GDHKDUBW5YA24X4
AWS_SECRET_ACCESS_KEY=<secret>
S3_BASE_PREFIX=trainertwin-dev/kb
```

*Note: `ENABLE_RECORDING`, `LLM_API_KEY`, and `LLM_MODEL` are completely deprecated and dropped.*
*`WEBHOOK_URL` is also dropped — the completion webhook path (`/api/sessions/webhook`) is hardcoded in `agent/src/agent.py` and derived from `WEB_URL`; room metadata may still override it.*

---

## 4. E2E Networks Server Operations

We manage the remote deployment on E2E Networks using the `e2e_cli` tool and direct SSH into the target Swarm node.

### CLI Binary & Node Details
- **CLI Location:** `/Users/suryaumapathy/.local/bin/e2e_cli`
- **Config Alias:** `foreverlearning` / `default`
- **Target Node ID:** `314265` (`M3-32GB-887`)
- **Public IP:** `216.48.181.196` (Location: Delhi)
- **SSH Command:** `ssh -i ~/.ssh/e2e_ed25519 root@216.48.181.196`
- **Remote App Directory:** `/opt/trainertwin-agent`

### Useful E2E CLI & Remote Inspection Commands
```bash
# 1. Check Node Status via E2E CLI
/Users/suryaumapathy/.local/bin/e2e_cli node list

# 2. Sync updated agent code to VM
rsync -avz -e "ssh -i ~/.ssh/e2e_ed25519 -o StrictHostKeyChecking=no" \
  --exclude '.local' --exclude 'logs' --exclude '.venv' \
  agent/ root@216.48.181.196:/opt/trainertwin-agent/

# 3. Rebuild Docker image & update Swarm service on VM
ssh -i ~/.ssh/e2e_ed25519 root@216.48.181.196 \
  "cd /opt/trainertwin-agent && docker build -t trainertwin-agent:local . && docker service update --image trainertwin-agent:local --force trainertwin-agent_agent"

# 4. View real-time service logs
ssh -i ~/.ssh/e2e_ed25519 root@216.48.181.196 \
  "docker service logs -f --tail 50 trainertwin-agent_agent"
```

---

## 5. Verification Checklist (Definition of Done)

Before marking Issue 2 as completed, execute and pass every item in this checklist:

### Pre-Flight & Code Verification
- [x] **Startup Env Check:** `agent/src/agent.py` validates all required keys at launch. Unsetting `LIVEKIT_URL` or `SARVAM_API_KEY` causes process exit with code `1` and a descriptive error message.
- [x] **Hardcoded Model:** `agent/src/session.py` sets `model="trainertwin-runtime"` with no OpenRouter fallback.
- [x] **No Direct LLM Keys:** No references to `os.getenv("LLM_API_KEY")` remain in `agent/src/session.py`.
- [x] **Missing Token Guard:** `agent/src/agent.py` verifies `runtime_token` exists in metadata before calling `build_agent_session()`.

### Remote Deployment Verification (E2E Server)
- [x] **Sync & Build:** Agent code synced to `/opt/trainertwin-agent`, image `trainertwin-agent:local` built cleanly without cache errors.
- [x] **Swarm Service:** `trainertwin-agent_agent` service is running 1/1 replica converged on node `e2e-98-196`.
- [x] **Worker Registration:** Dozzle / service logs show:

### End-to-End Call Verification
- [ ] **Session Launch:** Start a session from `https://dash.trainertwin.com/talk` (or local `/talk`).
- [ ] **Job Dispatch:** Worker receives job `AJ_...` with `dispatch_id`.
- [ ] **Dynamic Token Auth:** Worker calls `https://dash.trainertwin.com/api/v1/chat/completions` with `Bearer <runtimeToken>`. Web runtime returns `HTTP 200 OK` (no `401 Unauthorized`).
- [ ] **Opening Speech:** `TrainerAgent` emits the opening turn in Rohan's voice via Sarvam TTS.
- [ ] **Real-Time Turn Exchange:** Spoken candidate answer triggers a follow-up probe from `/api/v1/chat/completions`.

## Deployment Notes (2026-09-11)

- `docker stack deploy` does **not** roll the service when the image tag/spec is unchanged — after rebuilding `trainertwin-agent:local`, run `docker service update --image trainertwin-agent:local --force trainertwin-agent_agent` to pick up new code.
- Env check smoke-tested in the deployed image: missing vars → `Missing required environment variables: ...` + exit code 1.
