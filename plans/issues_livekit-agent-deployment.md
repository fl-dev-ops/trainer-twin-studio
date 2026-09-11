# Issue 1: LiveKit Agent Deployment (E2E Server)

## Context & Objectives
Deploy and maintain the voice agent worker on the E2E Networks server (`216.48.181.196`) using Docker Swarm (`trainertwin-agent` stack). Ensure environment variables and service definitions strictly match production requirements.

---

## Decisions & Requirements

1. **Target Web URL**
   - Web backend endpoint must point to the custom domain:
     ```env
     WEB_URL=https://dash.trainertwin.com
     WEBHOOK_URL=https://dash.trainertwin.com/api/sessions/webhook
     ```

2. **Agent Identity**
   - The registered worker name must strictly be:
     ```env
     AGENT_NAME=intervoo-agent
     ```
   - Matches LiveKit Cloud dispatch and token grants in `web/lib/livekit.ts`.

3. **TTS Provider**
   - Use Sarvam TTS with fixed male speaker:
     ```env
     TTS_PROVIDER=sarvam
     SARVAM_SPEAKER=rohan
     SARVAM_API_KEY=<key>
     ```

4. **Recording & S3 Egress**
   - Recording must always happen.
   - Drop `ENABLE_RECORDING` from `.env` and environment variables.
   - Enforce recording directly in `config.py` / `recording/egress.py`.
   - Ensure S3 bucket configuration:
     ```env
     AWS_REGION=ap-south-1
     AWS_S3_BUCKET=trainer-twin-prod
     S3_BUCKET=trainer-twin-prod
     ```

5. **LLM Environment Cleanup**
   - Drop `LLM_API_KEY` and `LLM_MODEL` from the agent environment entirely.
   - Keep only:
     ```env
     LLM_BASE_URL=https://dash.trainertwin.com/api/v1
     ```
   - Authentication and model selection are dynamic per-session, supplied by the runtime token and hardcoded runtime target.

6. **Process Management**
   - Maintain Docker Swarm service deployment (`trainertwin-agent` stack):
     ```bash
     docker stack deploy -c stack.yml trainertwin-agent
     docker service update --image trainertwin-agent:local --force trainertwin-agent_agent
     ```

---

## Action Items

- [ ] Update `agent/stack.yml` to remove `ENABLE_RECORDING`, `LLM_API_KEY`, `LLM_MODEL`, and set `WEB_URL=https://dash.trainertwin.com`.
- [ ] Update `agent/src/recording/egress.py` to always enable recording without checking `ENABLE_RECORDING`.
- [ ] Update `/opt/trainertwin-agent/.env` and `stack.yml` on the E2E server (`216.48.181.196`).
- [ ] Rebuild `trainertwin-agent:local` on E2E server and redeploy `trainertwin-agent_agent`.
- [ ] Verify worker registration in Dozzle/logs: `agent_name=intervoo-agent`, connected to LiveKit Cloud.
