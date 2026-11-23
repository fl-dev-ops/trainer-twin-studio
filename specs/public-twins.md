# Public twin voice calls

An org's admin/team can enable short, anonymous voice calls in a twin's existing settings. This is separate from
signed-in learner practice. [Website widgets](widgets.md) reuse this session/runtime boundary.

## Settings and access

- Public calls run on the twin's **bot**: a `BOT` agent on the same persona (`data.twinId` → the twin), made the first
  time public settings are saved (`web/lib/bots.ts`). It uses the trainer's voice and all of their twin skills like the
  main twin, but has its own name and purpose (`data.objective`, edited under Public access → Bot), so editing the twin
  for learners never changes what visitors get, and saving public settings never versions the twin.
- The bot's one `Deployment` with `channel = "public"` holds the settings: `status` `active` = public calls on (default
  `disabled`); `maxCallSeconds` 300, 600, 900, 1200 or 1800 (default 300). Archiving the twin takes the bot offline.
- Anonymous sessions belong to the bot (DB triggers: anonymous sessions only on `BOT`; a bot session must be anonymous,
  voice, and within an active public deployment). The twin's sessions list shows them with the twin's own.
- Links and widget snippets that name the twin's id keep working: public lookups resolve a twin id to its bot.
- The existing org-host `/t/<path>` page offers anonymous prejoin only when signed out and public access is enabled.
  A signed-in person's existing membership/assignment/credits rules are unchanged.
- Enabling access exposes that twin's current published skills; it is not a separate public-content selection.
- Prejoin requires a trimmed, self-reported name (1–80 characters, no control characters). This is not verified identity.
  It discloses AI, transcription, possible recording and org review before requesting microphone access.
- Public calls are voice-only, through LiveKit and the Python voice agent to `chat/`. No public completion proxy,
  typed messages, attachments, private documents, learner memory or workspaces.
- Anonymous LiveKit participant tokens allow microphone publishing only, bind one room/identity and expire at
  the persisted call deadline. UI controls are not the transport's security boundary.

Code: `web/lib/public-twin-settings.ts`, `web/lib/twin/manage.ts`, `web/lib/twin/trpc.ts`,
`web/lib/pages/learner.ts`, `web/components/twin/public-twin-call.tsx`, `web/lib/scenario-ingest.ts`.

## Identity, credentials and API

- A host-only HttpOnly, SameSite=Strict cookie holds an opaque random visitor token. Stored visitor/IP identifiers
  are org-scoped HMACs; no raw IP is stored. Clearing cookies does not reset the IP limit.
- Anonymous `InterviewSession` rows have no account, member or assignment; `anonymousId`, `anonymousName` and
  `anonymousIpHash` are required. Database checks reject mixed ownership, anonymous role plays and anonymous text calls.
- `POST /api/public/twins/<agentId>/sessions` accepts only `{name}`. Host selects org; matching Origin is required.
  Returns a session-scoped browser token, participant token and room. The agent runtime token is dispatch-only.
- `POST /api/public/sessions/<sessionId>/end` requires the visitor cookie, same org/Origin and browser bearer token.
  It is idempotent and accepts no browser-supplied transcript/evidence. The existing trusted agent webhook owns transcripts.
- Chat checks uncached service/session authorization before each incoming turn and each public speaking-model call.
  Public studio actions require the runtime token, live session and matching org/pinned agent/persona. Only pinned
  playbook retrieval, context/evidence and finishing are allowed; unsupported tools are rejected.

Code: `web/lib/public-twin-request.ts`, `web/lib/public-twin-sessions.ts`, `web/lib/interview-sessions.ts`,
`web/app/api/public/`, `web/app/api/copilot/studio/route.ts`, `chat/agent/lib/studio.ts`.

## Duration, funding and limits

- Public calls require an unpaused, billed org with enough balance for the full selected duration. They never inherit
  free/unlimited staff calls. The whole allowance is reserved under the existing org minutes lock.
- Starts are limited across the org: 3/hour per visitor or IP bucket; 30/hour total; 5 concurrent calls total;
  one concurrent call per visitor/IP bucket. Failed starts count toward restart limits but release credit reservations.
- Vercel's overwritten forwarded-IP header supplies the IP bucket. Other deployments deliberately share one bucket
  rather than trust arbitrary client headers; do not enable public use at scale there without a trusted proxy policy.
- Deadline is immutable `startedAt + allowedSeconds`, including startup. It is passed unchanged to the agent.
  Durable deadline cleanup must schedule successfully before runtime initialization; otherwise the call fails closed.
  Agent timer, token expiry checks and the existing sweep provide additional enforcement/recovery.
- Finalization writes one `org_usage` ledger row with null account/email, capped at the allowance. Browser end, agent
  webhook and deadline retries cannot charge twice. Anonymous calls appear in org twin history, not learner accounts.
- Public finish commands complete server-side; no workspace-capable browser client is required.

Code: `web/lib/public-twin-sessions.ts`, `web/lib/org-credits.ts`, `web/lib/minutes.ts`,
`web/workflows/public-call-deadline.ts`, `web/workflows/steps/public-call-deadline.ts`,
`web/lib/session-activation.ts`, `agent/src/agent.py`, `web/lib/workspace-commands.ts`.

## Runtime configuration and verification

The existing Workflow runtime must be operational. The voice agent requires `LLM_BASE_URL` pointing to the chat
deployment's `/v1` and `COPILOT_SERVICE_SECRET`; public calls refuse missing configuration or the legacy web
`/api/v1` runtime. Studio `CHAT_URL` and chat `STUDIO_URL` must point to their matching deployments.
Existing LiveKit, STT/TTS and recording configuration still applies.

Tests: `web/tests/lib/public-twin-*`, `web/tests/api/public-twin-*`, `web/e2e/public-twin.spec.ts`,
`chat/tests/agent/openai-compat.test.ts`, anonymous runtime tests in `chat/tests/`, and `agent/tests/test_public_runtime.py`.
