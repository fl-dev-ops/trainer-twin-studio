# Voice agent and chat

> Two services run a conversation. `agent/` is the Python LiveKit worker: it listens, sends text to a remote brain, and speaks the answer. `chat/` is the Eve brain: it reads the studio's session context, chooses instructions, retrieves evidence, and generates replies. The web app owns access, session records, workspace commands, and after-call processing. This spec describes those boundaries, not the web session lifecycle (see [Sessions](sessions.md)).

## Who uses it

| User | What they do here | Code |
| --- | --- | --- |
| Learner | Speaks or sends text in a LiveKit room; receives speech and workspace changes. | `agent/src/agent.py` `entrypoint`; `web/components/session-view.tsx` |
| Trainer / studio member | Tests a twin marked at Start; sends “Feel(s) off” feedback during that call. Access, creator-only live ratings and end-workflow scoring belong to [Twins](twins.md). | `chat/agent/channels/openai-compat.ts:49,249–250` `isFeelsOff`; `chat/prompts/twin-calibration.md`; `web/lib/interview-sessions.ts:398–403` |
| Web app | Creates the room, dispatches a named worker, supplies its runtime token and deadline, and receives completion. | `web/lib/session-activation.ts` `activateInterviewRuntime`; `web/lib/livekit.ts` `activateLiveKitSession` |
| Operator | Configures the worker, brain endpoint, providers, and shared service secret. | `agent/src/agent.py` `validate_environment`; `agent/stack.yml`; `chat/agent/lib/studio.ts` |

## Words used here

| Term | Meaning |
| --- | --- |
| Voice transport | The Python worker. It handles audio and room events, not the trainer's conversation policy (`agent/src/prompt.md`). |
| Brain | The Eve agent in `chat/`; its durable conversation history is separate from the Python voice history (`chat/agent/channels/openai-compat.ts`). |
| Studio | The web app. Chat calls its authenticated `POST /api/copilot/studio` action interface (`chat/agent/lib/studio.ts`). |
| Job metadata | JSON attached to the LiveKit dispatch; carries identity, agent credential, voice and deadline. Room metadata carries the same public facts but no credential (`web/lib/livekit.ts:86–106`; `agent/src/agent.py` parse_metadata, entrypoint). |
| Browser token | HMAC for commands/UI state/snapshot, returned as session.runtimeToken. Not the agent's model-call token (`web/lib/interview-sessions.ts:422–448`; see [Sessions](sessions.md)). |
| Session mode | Conversation behavior: `twin`, `twin-calibration`, `roleplay-client`, `roleplay-interview`, or `legacy-playbook`. This is not the delivery mode `voice` / `chat` (`chat/agent/lib/session-mode.ts`; `brain.ts` `SessionSpecs`). |
| Playbook / skill | A trainer's `SKILL.md` and its topic/situation catalog. A twin advises from it; a client role play acts from its own skill (`chat/agent/lib/brain.ts` `twinSessionPlaybooks`; `roleplay.ts` `roleplaySkill`). |
| Inline twin | A twin whose non-empty playbook set fits in the prompt; larger sets are exposed as Eve skills (`brain.ts` `inlineTwinPlaybooks`). |
| Query / decision model | Small model that writes a search query before an inline twin's learner turn; it does not speak the reply (`chat/agent/lib/twin-query.ts`). |
| STT / TTS | Speech-to-text / text-to-speech (`agent/src/session.py`; `agent/src/tts/__init__.py`). |
| Egress | LiveKit's recording service, writing a room recording to S3 (`web/lib/livekit.ts`). |
| Service secret | `COPILOT_SERVICE_SECRET`, shared by trusted services. It is distinct from the per-session `runtimeToken` (`agent/src/agent.py`; `recording/webhook.py`; `chat/agent/lib/studio.ts`). |

## Data

These runtimes own no application database tables. Web session storage, recordings and reports belong to [Sessions](sessions.md); twin skills and calibration ratings belong to [Twins](twins.md).

### LiveKit job metadata

The web writes the canonical fields below to room and dispatch metadata **except runtimeToken, which is dispatch-only**. Room metadata contains neither token. The worker still reads the first truthy source: job metadata, job-room metadata, then connected-room metadata. Invalid JSON/non-object becomes {}; it does not retry the next source after parse failure. A job with only current room metadata has no token and stops. Reusing a matching dispatch keeps its earlier metadata (`web/lib/livekit.ts:86–106` activateLiveKitSession; `agent/src/agent.py:73,267–274` parse_metadata, entrypoint).

| Field | Worker behavior |
| --- | --- |
| `sessionId` | Session ID. Accepts `session_id` alias; otherwise uses room name. |
| `runtimeToken` | Agent token, dispatch-only. Required to start the job; accepts runtime_token alias; missing/blank logs and returns. Used as the OpenAI client's API key, not the browser's credential. |
| `orgId` | Organization. Accepts `org_id`; defaults to `shared`. |
| `agentSlug` | Scenario/twin slug sent to the brain. The worker also accepts `agent_id`, which takes precedence. |
| `voice` | Optional voice identifier passed to TTS. |
| `hold_opening` | Truthy value holds the opening until the browser's `begin-opening` packet or a 60-second timeout. |
| `ends_at` | Optional positive numeric Unix timestamp in seconds. Booleans and strings are not deadlines. |
| `agent_kind` | Exact `ROLEPLAY` selects the client-style timed goodbye; all other values use the twin line. |
| `webhook_url` | Worker-only override; a leading `/` is resolved against `WEB_URL`, otherwise used as supplied. Defaults to `{WEB_URL}/api/sessions/webhook`. The web dispatcher does not set this field. |

Source for every field: `agent/src/agent.py` `entrypoint`, `seconds_until_end`, `goodbye_line`; canonical producer: `web/lib/livekit.ts` `activateLiveKitSession`.

### Runtime state

| Record | Contents and writer | Lifetime |
| --- | --- | --- |
| Python `_sessions[room]` | Session/token, webhook URL, participant identity, LiveKit `AgentSession`, usage reporter and screen observer. Worker writes it. | Added during `entrypoint`; popped by `on_session_end`. Not durable. |
| Eve session | Addressed by `x-trainertwin-session-id`; otherwise `token:<authorization remainder>`, otherwise a random address. Stores conversation history. | Reused across bridge requests at the same address (`openai-compat.ts`). |
| Eve instruction memo | Session prompt and playbook definitions. `ctx.memo` keys use the Eve session ID. | Fixed for that Eve session, including across processes (`instructions/session-spec.ts`; `skills/playbooks.ts`). |
| Eve interview state | Plan, résumé candidates, style cache and project knowledge. | Eve `defineState` records, including `trainertwin.session_plan` (`chat/agent/lib/plan-state.ts`). |
| Per-turn memo | Inline twin's selected lines and the interview plan instruction block. | Keyed by turn ID, reused for that turn's tool follow-ups (`instructions/twin-lines.ts`, `instructions/plan-turn.ts`). |
| Mode lookup cache | Promise of mode per org/session/agent; 10-minute expiry, evicts oldest when over 500. | Process-local; failed lookups are removed and return interview mode (`lib/session-mode-lookup.ts`). |

Voice lifecycle: metadata → connected room → started audio session → deadline/empty-room/browser ending → `on_session_end` → webhook attempt → room deletion. Missing runtime token stops before connection (`agent/src/agent.py`). This is worker control flow, not the web's stored status machine.

## How it works

### 1. Web starts a call and connects the services

1. Web activates the session and initializes chat through `{CHAT_URL}/internal/sessions`, using Bearer service auth and `x-trainertwin-org-id`. `CHAT_URL` defaults to `http://localhost:2000`. The chat handler checks configuration and whether a session exists; it returns `ready: true` but does not create or pre-generate an Eve conversation (`web/lib/interview-sessions.ts` `initializeChatSession`; `chat/agent/channels/openai-compat.ts`).
2. For voice, web resolves a ready, org/global voice: explicit agent override, then persona voice, then the alphabetically first ready global voice. It passes `ends_at = floor(now / 1000) + secondsLeft` when the activated session has a limit (`web/lib/session-activation.ts`). Access and minute calculations are owned by [Sessions](sessions.md) and [Credits](credits.md).
3. Web creates or updates the room named with the session ID and reuses an existing dispatch for the configured worker name. It returns a learner participant JWT and a separate browser HMAC token as session.runtimeToken. Voice POST strips the internal agentToken; that token is only in the agent dispatch, not room metadata. Chat delivery still returns conversationToken=agentToken (Mismatches). Recording is started here, not by the active Python entrypoint (`web/lib/livekit.ts` `activateLiveKitSession`).
4. Worker connects, waits up to about 30 seconds for a remote participant, and takes the first identity found. If none arrives, its fallback is `candidate-<sessionId>` (`agent/src/agent.py` `entrypoint`).
5. Worker builds an OpenAI-compatible LLM client. `LLM_BASE_URL` chooses the backend; the library fallback is `{WEB_URL}/api/v1`. Headers carry session ID, org ID, agent slug and delivery mode `voice`. With a service secret and a base URL not ending `/api/v1`, it overrides Authorization with `Basic base64(orgId:secret)` for chat. The web-runtime route keeps the per-session Bearer token (`agent/src/session.py` `build_agent_session`; `agent/src/agent.py` `entrypoint`).
6. `TrainerAgent` has only the transport prompt and `tools=[]`. The remote brain owns identity, grounding and decisions. Workspace actions go through the studio command queue and browser, not these Python tools (`agent/src/prompt.md`; `chat/agent/lib/workspace-tools.ts`; `web/lib/livekit-workspaces.tsx`).

### 2. Audio, opening and input

- STT uses Deepgram `flux-general-en`. Turn detection uses LiveKit inference `v1-mini`, dynamic endpointing 0.6–1.2 seconds, adaptive interruption (at least 0.5 seconds and two words), no preemptive generation, and a 90-second user-turn cap. LLM connection options allow three retries and a 60-second timeout (`agent/src/session.py` `build_agent_session`).
- Worker installs the data listener before connecting. Without `hold_opening`, it generates `session-start` immediately. With it, the opening waits up to 60 seconds for `begin-opening`; input is buffered and the mic is disabled while the held opening is spoken, then restored (`agent/src/agent.py` `TrainerAgent`, `entrypoint`).
- Data packets accept typed `chat-message`, MCQ submissions, chunked code submissions, and signed whiteboard evaluations. Code is limited to ten chunks, twenty pending submissions and 20,000 assembled characters. MCQ option text is capped at 2,000 characters. Whiteboard assessments must pass HMAC, room/participant/version/status/time checks and cannot reuse an accepted signature (`agent/src/agent.py` `on_data_received`). Workspace UI details belong to [Sessions](sessions.md).
- After the opening, an `away` user-state event (60 seconds silent) sends `__TRAINERTWIN_USER_INACTIVE__` to the brain. This nudges; it does not itself end the call (`agent/src/agent.py` `register_inactivity_nudge`; `agent/src/session.py`).
- A background screen observer reads published screen-share frames only for the chosen participant and supported code/whiteboard surface state. Its notes enter the Python history as developer context without starting a model turn; the bridge forwards new `[SCREEN OBSERVER NOTE]` notes with the learner's next input (`agent/src/screen_feedback/runtime.py`; `agent/src/agent.py` `inject_screen_note`; `chat/agent/channels/openai-compat.ts` `mapLatestMessage`).

### 3. Bridge and session state

1. `POST /v1/chat/completions` resolves org from a valid studio Basic principal or the org header. It maps only the latest relevant input, because Eve holds the conversation history. `session-start` becomes `[OPENING]`; tool results become `[TOOL RESULT]`. Transport system prompts are not substituted for the brain's instruction layers (`chat/agent/channels/openai-compat.ts` `mapLatestMessage`).
2. The request supplies auth attributes including org/session/agent/persona slugs, delivery mode, advertised tools and current `turnText`. `source.send(..., { turnPolicy: "steer" })` admits the turn. HTTP abort calls `source.cancel()` for barge-in (`openai-compat.ts`).
3. Session instructions call studio `getSessionContext`, then memoize the composed prompt. Web reads the session in the requested org; session slugs override input slugs. Snapshot agent/persona data wins over live data; the immutable kind comes from the live agent. All-skills twins use pinned `twinSkills` when present, otherwise the live list (`chat/agent/instructions/session-spec.ts`; `chat/agent/lib/brain.ts` `loadSessionContext`; `web/lib/session-context.ts` `buildSessionContext`).
4. Web context includes attached document manifests, résumé text/claims, learner name (`runtimeState.learner_name` before account name), warm-opening evidence and browser `runtimeState.uiState`. Its only automatically listed shared knowledge base is indexed `acme-knowledge`. Session-ID lookups are cached for 86,400 seconds. Chat does not poll this context each turn (`web/lib/session-context.ts`; `chat/agent/instructions/session-spec.ts`).
5. Calibration is a separate studio `isCalibrationSession` query for twins only. `calibrate: true` at web Start creates `TwinCalibration` in the call's transaction before chat initialization, so there is no late browser marker racing the memoized mode. The query checks the session ID/org for that row; failure logs and keeps normal twin behavior. Missing org or a context-load failure gives the full interview fallback prompt; it does not stop the call (`web/lib/interview-sessions.ts:398–419`; `web/app/api/copilot/studio/route.ts:269–274`; `chat/agent/lib/brain.ts:392–396,444–451`; `instructions/session-spec.ts`).
6. Brain tool calls execute inside Eve. Workspace tools enqueue durable studio commands; the browser polls and acknowledges them using its separate browser token via authorizeBrowserSession (activating/active only). Missing, wrong, agent or ended tokens return runtime_token_invalid/401, “This call is no longer available.” (`web/lib/interview-sessions.ts:430–448`; `web/app/api/sessions/[id]/commands/route.ts:14–17`; acknowledgment route:12–18.) `finish_session` also queues a command; it is not direct room deletion. `end_call` uses the same `finishSession` action (`chat/agent/lib/workspace-tools.ts`; `tools/end_call.ts`; `web/app/api/copilot/studio/route.ts`; `web/lib/livekit-workspaces.tsx`).
7. The bridge streams OpenAI-style SSE text, usage and completion markers. Known pure side-effect tool results can return an empty completed stream without another model call. A client `end_call` with no preceding speech gets an outcome-specific fallback goodbye. Turn evidence is posted for requests with a real session header (`chat/agent/channels/openai-compat.ts`).

### 4. Modes and prompt layers

Mode resolution is ordered: roleplay → twin (calibration variant if marked) → playbook → interview. It tests classified facts, not the `voice` / `chat` delivery flag (`chat/agent/lib/session-mode.ts` `sessionMode`).

| Mode | Classification and behavior | Prompt source |
| --- | --- | --- |
| `twin` | `TWIN` with `data.source="twin"` uses the persona's playbooks; `TWIN` with `source="twin-creator"` and a string skill advises from that one skill. Learner leads; give next move and words to say, not an interview. | `brain.ts` `twinSessionPlaybooks`, `formatTwinSession`; `prompts/twin.md` |
| `twin-calibration` | Same twin plus a `TwinCalibration` row created at Start. A standalone “Feel(s) off” message is mapped to calibration feedback; the prompt says ask what felt off, treat the next message as the trainer's explanation, briefly thank them and redo the last learner reply their way. Apply it for the rest of this call, not future skills. | `brain.ts` `isCalibrationSession`; `prompts/twin-calibration.md`; `openai-compat.ts:49,249–250` |
| `roleplay-client` | Any `ROLEPLAY` with a string `data.skill`. AI plays the client, not the coach. Skill and persona govern behavior; difficulty defaults to `medium`. Goals/rubric are not included in this prompt. | `lib/roleplay.ts` `roleplaySkill`, `formatRoleplaySession` |
| `roleplay-interview` | Fallback when none of the other facts applies. Interview agenda, evidence, résumé/knowledge tools and two-beat closing. | `prompts/base-instructions.md`; `brain.ts` `formatSessionSpec`; `tools/session_plan.ts` |
| `legacy-playbook` | Remaining `scenarioPlaybook`: an older skill run as a trainer/learner script. A `ROLEPLAY` skill resolves as client first, so cannot reach this branch. A twin-creator skill is excluded. | `brain.ts` `scenarioPlaybook`, `formatPlaybookSession`; `lib/session-mode.ts` |

**One feels-off text rule.** `web/lib/twin/stats.ts` `isFeelsOffMessage` lowercases, removes every character except ASCII letters and spaces, collapses remaining whitespace, trims, then matches exactly `feel off` or `feels off`. Case and punctuation are ignored: `FEELS  OFF!!` and `Feel off.` match; `it feels off` does not. Punctuation is removed, not replaced with spaces, so `feels-off` does not match. The web runtime imports this function, as do transcript joining/raw scoring and the call summary. Chat's local `isFeelsOff` uses the same expression; the old three different web/chat/counting rules are gone. (`web/lib/twin/stats.ts:27–29,136`; `web/lib/twin/calibration-score.ts:3,11,32,52`; `web/components/calibration/calibration-call.tsx:32,922`; `web/lib/runtime/openai.ts:6,68`; `chat/agent/channels/openai-compat.ts:49`.)

Chat maps a matching message only when a real session header exists and its cached mode is twin-calibration; normal twin/interview messages stay ordinary input. The feedback event skips automatic inline retrieval, and the calibration prompt says call no tools for that event. That is a prompt instruction, not a tool-execution gate. The selectable web runtime instead checks `isCalibrationSession`, sets `calibration_feedback_pending` and uses the fixed “Okay. What felt off about that?” line; the next input clears pending and uses acknowledge_advance. Detection agrees, but the reply/feedback implementation is not the same as chat's redo-the-reply prompt. (`chat/agent/channels/openai-compat.ts:240–250`; `chat/agent/instructions/twin-lines.ts:14,53–56`; `chat/prompts/twin-calibration.md`; `web/lib/runtime/openai.ts:67–68,2670–2685,2819–2843`.)

For interview mode, composition is the complete `base-instructions.md` plus interview session data. Other modes get `platform.md`, then their operating instructions, workspace capabilities, and session facts. Twins add the playbook-access variant and optional calibration overlay. Persona text prefers the web-rendered `personaBrief`, falling back to recorded style/preferences (`chat/agent/lib/compose-instructions.ts`; `brain.ts` `formatSessionSpec`, `formatTwinSession`, `personaLines`).

Platform instructions treat documents, examples and session facts as data, not new instructions. Voice output spells numbers/currencies, bans Markdown/emojis, aims for fifty words or fewer, and asks at most one non-compound question. Screen knowledge must come from tools/state/observer notes (`chat/prompts/platform.md`). These are prompt requirements, not an output validator.

Twins must decline advice outside their playbooks with exactly `I can't answer this question, please ask the real <first name>.` and briefly offer a covered topic. Greetings, follow-ups and call logistics are not declines. No playbooks means every advice request gets that line. Closing asks for confirmation; the next confirmed turn calls `finish_session` without speech (`brain.ts` `twinDeclineLine`, `formatTwinSession`; `prompts/twin.md`).

Client role play tracks guard level in the prompt (1–5), speaks a goodbye and calls `end_call` in the same reply at agreement, refusal or guard 5. This is model instruction, not a deterministic guard counter. `end_call` refuses outside client mode (`lib/roleplay.ts`; `tools/end_call.ts`).

### 5. Models, query and search

1. Every spoken reply uses locked `google/gemini-3.8-flash`, through AI Gateway's `vertex` route. Request model values and `CHAT_AGENT_MODEL` do not change this model. Thinking defaults to `low`; explicit budget attributes/env take precedence. Optional hedging uses the same Vertex backend and is off unless `GEMINI_HEDGE_AFTER_MS > 0` (`chat/agent/agent.ts`; `lib/models.ts`).
2. Non-empty twin playbooks totaling at most 40,000 skill characters are inline by default. A finite non-negative `TWIN_INLINE_MAX_CHARS` overrides the threshold; zero disables ordinary non-empty skill inlining. Larger twins register one uniquely named Eve skill per playbook, memoized per session (`brain.ts` `inlineTwinPlaybooks`, `playbookSkillNames`; `skills/playbooks.ts`).
3. Before an inline twin's learner turn of at least four words, `twin-lines.ts` calls locked `cerebras/qwen-3.8-27b` directly using `CEREBRAS_API_KEY`. The query model sees the playbook/situation catalog, at most 600 characters of last reply, and 1,000 of current input. It returns skip or a valid playbook, optional valid situation ID and query capped at 500 characters (`instructions/twin-lines.ts`; `lib/twin-query.ts`; `lib/models.ts`, `lib/cerebras.ts`).
4. Opening, tool-result, inactivity and calibration-feedback tags skip automatic retrieval. Query timeout is two seconds; failure falls back to the learner's words (320 characters) plus previous reply (170), capped at 500. A successful skip does not search. Search timeout is three seconds; empty/error results leave the playbook alone (`instructions/twin-lines.ts`; `brain.ts` `twinLinesQuery`).
5. Studio `searchScenarioItems` returns up to three trainer lines for that inline turn. They become a user-role instruction block marked `[THIS MOMENT]` and `[LINES FOR THIS MOMENT]`, explicitly data, not instructions. Evidence recording is asynchronous for real session headers (`instructions/twin-lines.ts`; `brain.ts` `formatTwinMomentLines`; `web/app/api/copilot/studio/route.ts`).
6. Larger twins use `eve__skill` and `scenario_examples` when phrasing matters. `scenario_examples` takes situation (2–500 characters), optional step/playbook/role, and limit 1–6 (default 3). Default role is `client` in client role play, `trainer` otherwise; agent slug comes from auth, not model input (`tools/scenario_examples.ts`; `prompts/twin-playbooks-skills.md`).
7. Studio scopes all-skills searches to pinned persona skills; a named matching ID/slug narrows it. An unknown name widens to all allowed skills, not another org. Other agents use their session's pinned agent version, or live version without a matching session. Embedding starts alongside DB lookups (`web/app/api/copilot/studio/route.ts` `searchScenarioItems`).
8. Chroma search uses the org's `main` collection, `type=scenario_item`, slug/version pairs and optional role/step/move/action filters. No step hits retries the whole scoped scenario; no versioned hits retries retained versions of those same slugs. Returned score is `1 - distance`; this function applies no relevance cutoff. See [Knowledge](knowledge.md) for embedding/store plumbing (`web/lib/main-collection.ts` `searchScenarioItems`, `scenarioScopeWhere`).

### 6. Deadline, empty room, recording and completion

- The deadline is read once after audio-session start. Remaining time is clamped at zero. No valid deadline means no deadline task. With more than forty seconds remaining, goodbye starts twenty seconds before expiry; forty seconds or fewer skips it (`agent/src/agent.py` `seconds_until_end`, `goodbye_delay`, `end_at_deadline`).
- Twin/default line: “We're nearly out of time for today, so let's stop here. Thanks for talking it through with me.” Exact `ROLEPLAY` line: “Sorry, I have to jump to another call now. Let's pick this up another time. Bye for now.” Speech is non-interruptible. After successful playout the learner mic is disabled. Playout waits at most twenty seconds; an error logs, and room deletion is still attempted at the remaining deadline (`agent/src/agent.py` constants, `end_at_deadline`).
- Disconnect does not automatically close the audio session (`close_on_disconnect=False`). An empty-room watcher polls every five seconds, then allows six more five-second checks. If no remote participant returns, it marks `ABANDONED` and attempts room deletion. Any remote participant cancels that grace period. Deletion errors are logged, not retried by this watcher (`agent/src/agent.py` `watch_empty_room`).
- Active recording is web-owned: one composite MP4 video with mixed audio, screen share and participant tiles, H264 1080p30, key `{S3_BASE_PREFIX}/{orgId}/recordings/{room}/video.mp4`. Web reuses a starting/active/ending egress; no bucket skips recording, start failure logs without failing the call (`web/lib/livekit.ts` `recordingOutput`, `activateLiveKitSession`).
- Python still exports separate audio/video egress helpers, including stop-and-poll, but `entrypoint` and `on_session_end` do not call them. Thus the normal Python completion payload's recording fields are null; web activation already stores the video key and egress ID (`agent/src/recording/egress.py`; `agent/src/agent.py`; `web/lib/session-activation.ts`).
- On session end, worker closes the screen observer (five-second bound), flushes usage (six-second bound), and serializes non-empty user/assistant history messages as `user` / `trainer`. `spokenAt` is epoch milliseconds from `started_speaking_at` or message creation. Payload fields are `session_id`, `room_name`, `audio_url`, `audio_s3_key`, `video_url`, `video_s3_key`, `status`, `participant_identity`, `transcript`. Status defaults to `COMPLETED`; empty-room ending sets `ABANDONED` (`agent/src/agent.py` `on_session_end`).
- Webhook uses JSON and Bearer `COPILOT_SERVICE_SECRET`, with a fifteen-second request timeout. Missing secret logs and sends nothing. Only HTTP 5xx gets one retry after two seconds; 4xx and network errors are logged without retry. After delivery attempt, the worker attempts room deletion (`agent/src/recording/webhook.py`; `agent/src/agent.py` `on_session_end`).
- Web verifies the secret with constant-time comparison before reading JSON, validates bounded payload shape, resolves ID/share code (also strips `session-`), then finalizes and schedules the applicable processing. Unknown session returns 404; malformed payload 400; unauthorized 401. Canonical transcript replacement/readiness uses usesAgentTranscript, including twins and new role plays. Explicit video_s3_key is retained only if orgOwnKey(session.orgId, key) accepts it; video readers guard again before signing. Audio keys/URLs and report-record fields are not equivalently filtered. Browser finalize cannot set these fields or transcriptFinal; PATCH sessions/recording upload no longer exist. Recognized status uses the shared row-locked end path; COMPLETED can still promote abandoned, an undecided End question. Details belong to [Sessions](sessions.md) (`web/app/api/sessions/webhook/route.ts`; `web/lib/session-after.ts`).

### 7. Configuration and deployment

`validate_environment` exits with code 1 if any of these is blank: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `AGENT_NAME`, `WEB_URL`, `LLM_BASE_URL`, `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. It also requires either `AWS_S3_BUCKET` or `S3_BUCKET`. Speech is VoxCPM2 only; `TTS_PROVIDER` and `SARVAM_*` are not read (`agent/src/agent.py`; `agent/src/tts/__init__.py`).

| Additional configuration | Behavior / source |
| --- | --- |
| `COPILOT_SERVICE_SECRET` | Needed for chat Basic auth, completion webhook and usage; not included in the startup required list (`agent.py`; `recording/webhook.py`; `usage.py`). |
| `LLM_MODEL` | Defaults to `trainertwin-runtime`; `trainertwin-runtime` and `trainertwin-brain` are backend default-model markers (`session.py`; `chat/agent/channels/openai-compat.ts`). |
| Speech | VoxCPM2 only. `build_tts` does not branch on `TTS_PROVIDER` (`agent/src/tts/__init__.py`). |
| VoxCPM2 endpoint | `VOXCPM2_ENDPOINT`, then `TTS_SERVICE_URL`, then `{WEB_URL}/api/tts/speech`; append `/v1/audio/speech` unless already a supported speech path. Optional Bearer `TTS_API_KEY` or `TTS_SERVICE_KEY` (`tts/voxcpm2.py` `build_voxcpm2_tts`). |
| VoxCPM2 voice | Session voice, then `AGENT_VOICE_ID_OVERRIDE`, `AGENT_DEFAULT_VOICE_ID`, `VOXCPM_VOICE`; fallback `AGENT_FALLBACK_VOICE_ID` or `charlotte-sample`. A 404 response containing “unknown voice” retries with fallback for the rest of that session. Streams PCM; default 48 kHz, mono (`tts/voxcpm2.py`). |
| Sentence flush | `TTS_IDLE_FLUSH_MS`, default 200; non-positive disables the idle sentence flush wrapper (`tts/__init__.py`; `tts/sentence_flush.py`). |
| Screen / whiteboard | `SCREEN_VISION_MODEL` defaults to `openai/gpt-5.5`; observer uses OpenRouter. Whiteboard signing uses `WHITEBOARD_EVALUATION_SIGNING_SECRET` or `LIVEKIT_API_SECRET` (`screen_feedback/vision.py`; `agent.py`). |
| Chat dependencies | `STUDIO_URL` (default `http://localhost:3000`), service secret, `AI_GATEWAY_API_KEY` for speaking, `CEREBRAS_API_KEY` for query decisions. Optional Langfuse credentials export traces (`chat/agent/lib/studio.ts`, `models.ts`, `cerebras.ts`; `chat/agent/instrumentation/langfuse.ts`). |

Deployment has two worker targets: the LiveKit Cloud agent and the Docker service on the E2E VM. Both are intended to register as `intervoo-agent`; registration name, not container/service name, is what web dispatch matches. Checked-in evidence and limits:

- **LiveKit Cloud:** `agent/livekit.toml` identifies a cloud project and agent ID; `plans/prod-release-v2.md` names LiveKit Cloud as the worker target. Worker registration uses `AGENT_NAME` (default `intervoo-agent`), while web prefers `LIVEKIT_AGENT_NAME`, then `AGENT_NAME`, then `intervoo-agent` (`agent/src/agent.py`; `web/lib/livekit.ts`). Actual cloud env is not checked here.
- **E2E VM Docker service:** `agent/stack.yml` defines one Swarm `agent` replica, manager placement, host network, `trainertwin-agent:local` image, thirty-second stop grace, and on-failure restart (five-second delay, max ten attempts per 120 seconds). Its default `AGENT_NAME` is `intervoo-agent`, `WEB_URL=https://dash.trainertwin.com`, and `LLM_BASE_URL=https://chat.trainertwin.com/v1`. The file does not identify the VM host or prove it is running on E2E; that host label is supplied by this module's task, not discovered from the manifest.
- **Image:** multi-stage `agent/Dockerfile` uses Python 3.13 by default, locked non-dev dependencies, downloads LiveKit assets, runs as non-root, and starts `python -m livekit.agents start src/agent.py`. `agent/taskfile.yaml` supplies install/download/dev/start/test commands. A separate older `agent/docker-compose.yml` uses `devopsfl/intervoo-ai-agents:latest`, `.env`, and `unless-stopped`; it is not the Swarm manifest.
- **Chat:** `chat/package.json` builds/starts Eve on Node 24; `chat/vercel.json` enables fluid compute. The release plan places chat on Vercel. Point the worker at chat's `/v1` and chat at the studio origin; `/internal/sessions` is resolved from the separate web `CHAT_URL` (`plans/prod-release-v2.md`; `agent/stack.yml`; `chat/agent/lib/studio.ts`; `web/lib/interview-sessions.ts`).

## Rules

1. Missing/blank runtime token must stop a Python job before room connection (`agent/src/agent.py` `entrypoint`).
2. Worker startup must reject missing required env or both missing bucket names; provider choice does not relax the list (`agent.py` `validate_environment`).
3. A held opening must release on `begin-opening` or the sixty-second timeout, with learner input held until that opening is spoken (`agent.py` `TrainerAgent`, `entrypoint`).
4. Only a positive numeric, non-boolean `ends_at` meters the call; elapsed deadlines become zero remaining seconds. Goodbye requires strictly more than forty remaining seconds (`agent.py` `seconds_until_end`, `goodbye_delay`).
5. Only exact `agent_kind="ROLEPLAY"` uses the client deadline goodbye (`agent.py` `goodbye_line`).
6. Empty-room abandonment requires the grace checks to remain empty. Any remote participant returning interrupts the grace period (`agent.py` `watch_empty_room`).
7. Missing webhook service secret must send no request. Wrong/missing receiver credentials must return 401 before parsing or changing session data (`recording/webhook.py`; `web/app/api/sessions/webhook/route.ts`).
8. A web dispatch reuses the existing matching agent-name dispatch; worker and web registration names must match. Its agent token must be in dispatch metadata only, with no token in room metadata. Browser live features use authorizeBrowserSession, not authorizeRuntimeSession (`web/lib/livekit.ts` `activateLiveKitSession`; `agent.py` `server.rtc_session`).
9. A roleplay fact outranks twin/calibration facts; calibration alone must not change interview mode. The bridge treats the shared-rule standalone “Feel(s) off” signal as calibration feedback only with a real session header and twin-calibration mode; other modes retain the message. Web counting/runtime use `isFeelsOffMessage`; chat keeps its matching copy. (`chat/agent/lib/session-mode.ts` `sessionMode`; `chat/agent/channels/openai-compat.ts:49,249–250`; `web/lib/twin/stats.ts:136`; `web/lib/runtime/openai.ts:68`.)
10. Interview composition must retain the full base prompt; other modes use the platform prompt, not the interview base (`lib/compose-instructions.ts`).
11. A twin with no matching playbook must be instructed to use the exact first-name decline; examples are style evidence, not facts about the current learner (`brain.ts` `twinDeclineLine`; `prompts/twin.md`, `platform.md`).
12. Inline retrieval must skip tagged control events and inputs shorter than four words. Query/search failures must leave the turn able to proceed without retrieved lines (`instructions/twin-lines.ts`).
13. Search may only use the authenticated org and permitted skill slugs. A missing version may widen to retained versions, but not unrelated slugs (`tools/scenario_examples.ts`; studio route `searchScenarioItems`; `main-collection.ts` `searchScenarioItems`).
14. Disabled workspace switches must refuse their tools even on replay; absent settings mean all surfaces off. `read_document` is always available, and `finish_session` bypasses surface switches (`chat/agent/lib/agent-tools.ts`; `workspace-tools.ts`; `tools/read_document.ts`).
15. Client-roleplay guards disable trainer search/plan tools at execution; this is not a universal per-mode tool-hiding system. `end_call` must refuse all other modes (`session-mode-lookup.ts` `roleplayGuard`; `tools/search_style.ts`, `search_knowledge.ts`, `session_plan.ts`, `end_call.ts`).
16. Speaking and decision model IDs are locked in source; per-request model names must not change the speaking model (`chat/agent/agent.ts`; `lib/models.ts`).

## Entry points

| Entry | File / purpose |
| --- | --- |
| Python `trainertwin` / `intervoo`; `python src/agent.py dev`; production LiveKit `start` | `agent/pyproject.toml`; `agent/src/agent.py` `main`; `agent/taskfile.yaml` |
| Named LiveKit job and end callback | `agent/src/agent.py` `entrypoint`, `on_session_end`, `server.rtc_session` |
| LiveKit data packets / user-state / screen-share events | `agent/src/agent.py`; `agent/src/screen_feedback/runtime.py` |
| `POST /v1/chat/completions` on chat | `chat/agent/channels/openai-compat.ts`: Eve streaming bridge |
| `POST /internal/sessions` on chat | Same channel: service-authenticated readiness/existence check |
| Eve channel | `chat/agent/channels/eve.ts`: studio Basic auth and Eve local-development auth |
| Per-call instructions / skills | `chat/agent/instructions/{session-spec,twin-lines,plan-turn}.ts`; `chat/agent/skills/playbooks.ts` |
| `POST /api/copilot/studio` on web | `web/app/api/copilot/studio/route.ts`: context, search, document reads, calibration check, commands, evidence |
| `POST /api/sessions/webhook` on web | `web/app/api/sessions/webhook/route.ts`: authenticated completion receiver |
| `POST /api/internal/usage` on web | `agent/src/usage.py`; `chat/agent/lib/usage.ts`: usage producers; see [Platform](platform.md) |
| Replay evaluation script | `chat/scripts/twin-replay-eval.ts`: offline twin reply comparisons, not a live session endpoint |

## Talks to

| Other module / service | Contract |
| --- | --- |
| [Sessions](sessions.md) | Web supplies authorized session metadata and runtime token; receives commands, transcripts, completion and recording references. |
| [Twins](twins.md) / [Role plays](roleplays.md) | Supply pinned agent/persona/skill configuration; chat selects mode and formats it (`brain.ts`; `roleplay.ts`). |
| [Personas and voice](personas-and-voice.md) | Supply persona brief, recorded style, and the ready voice ID the worker speaks with (`session-activation.ts`; `tts/voxcpm2.py`). |
| LiveKit Cloud | Jobs/rooms, media, turn inference, noise cancellation, composite recording (`agent/src/session.py`, `agent.py`; `web/lib/livekit.ts`). |
| Deepgram / VoxCPM2 | Deepgram Flux turns audio into text. VoxCPM2 turns the reply into speech (`agent/src/session.py`; `agent/src/tts/*`). |
| AI Gateway / Vertex / Cerebras | Speaking model and fast twin query decision (`chat/agent/agent.ts`; `lib/models.ts`, `twin-query.ts`). |
| Studio / Chroma / S3 | Scoped evidence searches and document reads; composite recording storage. Chat accesses studio, not the DB directly (`lib/studio.ts`; web studio route; `web/lib/livekit.ts`). See [Knowledge](knowledge.md). |
| OpenRouter | Python screen-vision requests (`agent/src/screen_feedback/vision.py`). |
| Usage / Langfuse | Python STT/TTS/conversation usage and chat LLM usage/traces. Missing Python service secret disables its reporting (`agent/src/usage.py`; `chat/agent/instrumentation/*`). Voice traces are LiveKit agents 1.8: turn text is span attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`), not the old `gen_ai.*.message` events. Neither Langfuse project has a saved dashboard, widget, evaluator, or score config that queries the old events. See [Platform](platform.md). |

## Edge cases and limits

- **Bridge authentication is weaker than studio/webhook authentication.** Valid Basic is supported, but completion requests can also proceed with just `x-trainertwin-org-id`; the Bearer remainder is used for addressing, not verified here. Even malformed Basic can fall back to the org header. `/internal/sessions` does verify its Bearer secret (`chat/agent/channels/openai-compat.ts`; `lib/auth.ts`). Do not treat this bridge as a verified per-user authorization boundary.
- **Context is not a live session-state feed.** Web's 24-hour context cache plus Eve's session memo can retain old attached-artifact/UI state. Mid-call attachment markers use `withAttachments` / `resolveUpload` separately; interview plan state is updated separately in Eve (`web/lib/session-context.ts`; `chat/agent/instructions/session-spec.ts`; `lib/uploads.ts`, `plan-state.ts`).
- **No durable completion retry queue.** Worker state is in memory, final delivery logs errors, and only one HTTP-5xx retry exists. A crash/missed webhook can lose the final transcript; browser finalization is a separate fallback, not a guaranteed substitute (`agent/src/agent.py`; `recording/webhook.py`; see [Sessions](sessions.md)).
- **Deadline timing is best effort.** Task begins after session start; room deletion errors are swallowed. The goodbye's mic disable is inside the successful-playout try block. Failure/timeout can leave input enabled until deletion (`agent/src/agent.py` `end_at_deadline`).
- **Fixed English farewell.** A `shortcut:` comment defers persona-written/localized timed goodbyes. The worker does not regenerate them from the twin/client prompt (`agent/src/agent.py` goodbye constants).
- **Retained-version fallback.** Search can return another retained version when pinned items are missing/pruned. This is a deliberate fallback, not strict immutable example playback (`web/lib/main-collection.ts` `searchScenarioItems`, `pruneScenarioItems`).
- **Local TLS exception.** Webhook and VoxCPM2 code can disable certificate verification for HTTPS `.localhost` when the local CA is absent; this branch is not used for ordinary production hostnames (`recording/webhook.py`; `tts/voxcpm2.py`).
- **Chat has no session timeout/usage ceiling configured.** Eve limits are explicitly false; voice limits come from room/deadline handling, not the model (`chat/agent/agent.ts`).

## Mismatches

### Against ending and token rules

| Rule / refusal | Remaining difference (current file:line) |
| --- | --- |
| Practice 26: the agent token never reaches the browser | Voice POST now strips agentToken and room metadata has none, but chat Start returns it as conversationToken. Rule 26 has no chat exception (`web/lib/session-activation.ts:66`; `web/workflows/start-session.ts:13`; `web/app/api/sessions/route.ts:49–55`). |
| Practice 9, 26 / runtime_token_invalid: model calls only while live | Chat completions permit an org header without a valid Basic principal; Bearer is used for addressing, not verified against a live call. The web model route does enforce the agent hash/live status but returns OpenAI-shaped errors with other messages and no practice code (`chat/agent/channels/openai-compat.ts:184–192`; `web/lib/runtime/openai.ts:1964–1975`). |
| People 23 / not_found, invalid_input: webhook R refusal contract | Service auth is secure but error-only; bad payload/missing ID uses 400 without invalid_input, missing call uses “Session not found: <id>” without code, and lookup includes soft-deleted calls (`web/app/api/sessions/webhook/route.ts:44–70`). Audio signing/provenance and final-transcript fallback limits are in [Sessions — Mismatches](sessions.md#mismatches). |

### Against calibration rules

| Rule / check | Remaining difference (current file:line) |
| --- | --- |
| Practice 16: a test checks web and chat agree | Production predicates now match and the web runtime shares the counting rule. The parity test compares web against another regex copied into the test, not chat's actual predicate. A later chat-only edit can pass it; chat's bridge test covers “Feels off” but not the parity variants. (`web/tests/lib/twin-stats.test.ts:51–58`; `chat/agent/channels/openai-compat.ts:49`; `chat/tests/agent/lib/session-mode.test.ts:132–136`.) |

Creation/rating/visibility and eventual-score gaps are in [Twins — Mismatches](twins.md#mismatches) and [Sessions — Mismatches](sessions.md#mismatches); runtimes do not create calibrations, save ratings or score them.

| Intent / older description | Current code |
| --- | --- |
| `PRODUCT.md` says Pipecat and deterministic published-spec execution; root `README.md` describes the web analyze/policy/render path. | Current worker is LiveKit and can use Eve at `LLM_BASE_URL`; Swarm defaults to chat `/v1`. The web runtime remains a selectable backend (`agent/src/agent.py`, `session.py`; `agent/stack.yml`). |
| `plans/chat-twin-roleplay.md` proposes one resolver and hidden per-mode tools, twin-specific finish text, and latest saved ratings in the prompt. | Mode classification exists, but context/skills/tools still make separate memoized requests; many tools remain declared. `finish_session` still says never finish before `session_plan`, conflicting with twin closing instructions. No saved-rating examples are loaded; calibration overlay applies feedback from the current conversation (`session-mode-lookup.ts`; `skills/playbooks.ts`; `tools/finish_session.ts`; `brain.ts`; `prompts/twin.md`). |
| Chat calibration overlay says redo the last learner reply after the trainer explains; web is still a selectable runtime. | Feels-off detection is now shared, but web uses a fixed follow-up and acknowledge_advance/next-question behavior instead of that overlay. Saved calibration ratings are not loaded into either future-call prompt. (`chat/prompts/twin-calibration.md`; `web/lib/runtime/openai.ts:67–68,2670–2685,2819–2843`; `chat/agent/lib/brain.ts:828`; `plans/chat-twin-roleplay.md` §3.5.) |
| That plan defers client role play to a future branch. | `ROLEPLAY` with a string skill already runs the client prompt and `end_call` (`lib/roleplay.ts`; `tools/end_call.ts`). |
| `plans/twin-content-inventory.md` describes live skills, old coaching-shaped skills and no calibration; `plans/twin-roleplay-db-split.md` initially notes latest-only example items. | Context uses pinned skill lists/versions, twin-creator skills advise on one topic, calibrations have their own overlay, and Chroma stores versioned items with retained-version fallback (`web/lib/session-context.ts`; `chat/agent/lib/brain.ts`; `web/lib/main-collection.ts`). |
| `plans/twin-skill-ingest.md` proposes moving items to a `twin` collection. | Runtime search still uses `MainCollectionService.COLLECTION_NAME="main"` (`web/lib/main-collection.ts`). |
| `agent/.env.example` calls recordings optional and omits `LLM_BASE_URL`/service secret. | Startup requires S3 credentials/bucket and `LLM_BASE_URL`. Speech is VoxCPM2 only. Completion requires the service secret, which startup does not check (`agent/src/agent.py`; `tts/__init__.py`; `recording/webhook.py`). |
| `chat/README.md` describes Bearer-plus-org auth and Python room RPC; bridge comments still describe a request model override. | Bearer is not validated at the completion route; speaker is source-locked; active workspace execution uses studio commands/browser polling with Python `tools=[]` (`openai-compat.ts`; `agent.ts`; `workspace-tools.ts`; `web/lib/livekit-workspaces.tsx`; `agent/src/agent.py`). |
| `plans/twin-wiring-and-reliability.md` originally scopes canonical final transcripts to twins. | Receiver also uses agent transcript readiness for new role plays through `usesAgentTranscript` (`web/app/api/sessions/webhook/route.ts`; `web/lib/session-after.ts`). |

## Open questions

- **What “End” means remains undecided.** /s manual End sends abandoned; the agent defaults COMPLETED and the receiver can promote an already-abandoned call, including sweep/disable/replacement. Do not treat the proposed completed-for-End/live-only-webhook change as agreed policy. See [Practice — Open questions](practice.md#open-questions) and [Sessions](sessions.md#open-questions) (`web/components/session-view.tsx:515–519`; `agent/src/agent.py` on_session_end; `web/app/api/sessions/webhook/route.ts:75–107`; `web/lib/interview-sessions.ts:78–104`).
- Is `/v1/chat/completions` protected by an external gateway in deployed chat? Source permits org-header-only access, while `chat/README.md` describes authentication and `lib/auth.ts` requires the shared secret for a Basic principal (`chat/agent/channels/openai-compat.ts`). No external protection is established here.
- Should twin `finish_session` keep interview-only tool instructions? The twin prompt says not to call `session_plan`, while the finish tool says never finish before that plan reports finish (`chat/prompts/twin.md`; `chat/agent/tools/finish_session.ts`).
- How are post-start UI state and attached document lists meant to refresh in the static prompt? Context cache says immutable, yet it reads mutable `runtimeState.uiState` and documents; separate attachment handling does not refresh the entire prompt (`web/lib/session-context.ts`; `chat/agent/instructions/session-spec.ts`; `chat/agent/lib/uploads.ts`).
- Which LiveKit project/credentials does the E2E VM target, and are both registered workers intentionally eligible for the same dispatch? Cloud identity is in `agent/livekit.toml`; VM env is external to `agent/stack.yml`. Shared registration names alone do not establish routing or deployed health.

## Tests today

| Layer | Existing coverage |
| --- | --- |
| Python `agent/tests` | `test_agent_env.py`: required env, inactivity gate, latency logs, completion transcript. `test_minutes_limit.py`: deadline parsing, clamping, goodbye threshold and kind. `test_session.py`: VoxCPM2 builder. `test_recording.py`, `test_webhook.py`: recording key and webhook secret/delivery. `test_voxcpm2_tts.py`, `test_sentence_flush.py`: speech adapter/fallback and idle flush. `test_screen_feedback_runtime.py`, `test_tools.py`, `test_usage.py`: observer, older tool helpers and usage. |
| Chat unit / mocked integration | `chat/tests/agent/lib/session-mode.test.ts`: mode precedence, prompt isolation, calibration events, byte-identical interview golden fixture. `twin.test.ts`: twin classification, skill names, single-skill advisor and decline boundary; `session-mode.test.ts` also checks inline prompt composition. `playbook.test.ts`, `roleplay.test.ts`, `agent-tools.test.ts`: legacy/client prompts and workspace switches. `chat/tests/agent/openai-compat.test.ts`, `model.test.ts`: bridge output and model configuration. `instructions.test.ts`, `instrumentation.test.ts`, `usage.test.ts`: instruction/tracing/usage behavior. |
| Interview brain units | `chat/tests/agent/lib/{session-plan,plan-turn-block,mcq-state,resume-candidates,question-bridge,project-knowledge,style-cache}.test.ts`. Additional colocated tests exist under `chat/agent/`; `chat/package.json`'s `test` script only targets `tests/`. |
| Web boundary unit / API | `web/tests/lib/livekit.test.ts`, `minutes-livekit.test.ts`: dispatch configuration and deadline inputs. `scenario-item-versions.test.ts`, `scenario-step-index.test.ts`: version/filter rules. `web/tests/api/session-webhook.test.ts`: authenticated completion and transcript behavior. |
| Calibration contract (Module 3) | `web/tests/lib/twin-stats.test.ts` checks case/punctuation/“feel off” examples against a copied chat regex, not the live chat function. `chat/tests/agent/lib/session-mode.test.ts` checks calibration overlay isolation/redo instructions and that the bridge maps “Feels off” only for a calibration. Atomic creation and end-workflow scoring tests belong to [Twins](twins.md#tests-today) and [Sessions](sessions.md#tests-today). An earlier refresh ran bun test tests/agent/lib/session-mode.test.ts in chat: 8 passed; not rerun for Module 5. |
| DB / browser | Web DB and browser session coverage belongs to [Sessions](sessions.md) and [Twins](twins.md). No real Cloud/E2E-VM audio deployment smoke test is demonstrated by the unit suites above. |

Historical checks from the earlier spec write, not rerun for Module 5: 30 chat tests passed across the mode/twin/client/playbook/model/bridge files; 37 Python tests passed and one failed. `agent/tests/test_agent_env.py::test_on_session_end_sends_transcript` supplies an `Item` without `metrics` or `created_at`, while `agent/src/agent.py` `on_session_end` now reads them for timestamps. No test or runtime code was changed.

Important gaps: inline-size threshold and automatic query/search timeout branches, timed task behavior against real room deletion, held-opening/reconnect races, empty-room abandonment in a real call, deployed bridge access controls, cross-process live turn cancellation, and provider/model adherence to prompt-only boundaries. Existing pure deadline tests do not prove the call stops on a live server (`agent/tests/test_minutes_limit.py`; `agent/src/agent.py`).

Module 5 source coverage at c131296, inspected but not run here: web/tests/lib/minutes-livekit.test.ts checks dispatch-only runtimeToken and token-free room metadata; web/tests/api/session-start.test.ts checks agentToken removal from the voice response; web/tests/api/practice-runtime.db.test.ts checks browser/agent separation, closing and runtime_token_invalid on live-feature routes; web/tests/api/session-webhook.test.ts checks org-scoped explicit video keys and service-secret completion. No Python/chat suite or live call was run for this spec-only refresh.
