Implementation plan: Web-hosted OpenAI-compatible TrainerTwin provider

 No code changes yet.

 Target architecture

 ```text
   Browser audio
     → Pipecat VAD/STT
     → Pipecat OpenAILLMService
     → POST web/api/llm/v1/chat/completions
         → session/spec snapshot
         → Chroma retrieval
         → structured analyzer
         → deterministic controller
         → renderer or OpenAI tool_call
     ← OpenAI-compatible SSE stream

   If tool_call:
     Pipecat executes registered local/workspace tool
     → appends assistant tool_call + tool result
     → calls the same endpoint again
     → receives final response
     → TTS
 ```

 After the migration, Pipecat should use the standard OpenAILLMService. Switching providers should
 require only:

 - base_url
 - api_key
 - model

 The current agent cannot achieve this through a base URL change alone because it currently uses
 InterviewBrainProcessor instead of an LLMService. That is a one-time pipeline migration.

 ────────────────────────────────────────────────────────────────────────────────

 Recommended design decisions

 These should be fixed before implementation:

 ┌────────────────────┬────────────────────────────────────────────────────────────────┐
 │ Decision           │ Recommendation                                                 │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Protocol           │ OpenAI Chat Completions, not the entire OpenAI API             │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Endpoint           │ /api/llm/v1/chat/completions                                   │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Pipecat service    │ Unmodified OpenAILLMService                                    │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Model alias        │ trainertwin-runtime                                            │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Authentication     │ Session runtime token as Bearer API key                        │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Session identity   │ Resolve from token; do not encode it in prompts                │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Retrieval          │ Internal web operation, never a Pipecat tool                   │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Tool execution     │ Pipecat registered handlers                                    │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Tool authorization │ Advertised by Pipecat and allowed by the active spec           │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Tool concurrency   │ Emit one tool call at a time initially                         │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Streaming          │ Buffer, validate, then emit compliant SSE                      │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ State              │ Postgres is authoritative                                      │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Specs              │ Immutable compiled snapshot pinned when session starts         │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Tool set           │ Register the trusted session superset once; web gates by phase │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Closing            │ Pipecat-local finish_session tool and existing audio boundary  │
 ├────────────────────┼────────────────────────────────────────────────────────────────┤
 │ Text preview       │ Same OpenAI endpoint, including the same tool loop             │
 └────────────────────┴────────────────────────────────────────────────────────────────┘

 ────────────────────────────────────────────────────────────────────────────────

 Phase 1 — Freeze current behavior

 Before porting anything, capture the behavior that must survive.

 1.1 Create language-neutral controller fixtures

 Convert the meaningful cases in agent/test_interview.py into JSON fixtures containing:

 - Compiled Persona/Agent/Domain configuration
 - Initial runtime state
 - Learner input
 - Stubbed analyzer output
 - Expected validated analysis
 - Expected action
 - Expected state transition
 - Expected phase/probe changes
 - Expected close behavior

 Include:

 - Strong and partial evidence
 - Invalid evidence keys
 - Non-verbatim evidence quotes
 - Clarifications that do not spend probe budget
 - Stop requests
 - Phase budget exhaustion
 - Resume grounding
 - Hypothetical design
 - Coding execution restrictions
 - Contradictions
 - Feedback phase
 - Renderer validation and fallback

 1.2 Record representative session traces

 Capture several complete sessions from the Python runtime:

 - Resume mastery
 - Fundamentals
 - System design
 - Full mock interview
 - Coding stage with a mocked trusted execution result
 - Provider failure and retry
 - Interrupted turn

 Exact prose does not need to match after the port. The following should match:

 - Classification
 - Applied evidence
 - Coverage transitions
 - Selected actions
 - Phase transitions
 - Retrieval decisions
 - Closing reason

 Acceptance

 - Existing 28 Python tests still pass.
 - Fixtures cover every deterministic branch being ported.
 - No behavior is intentionally changed during migration.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 2 — Prove OpenAI/Pipecat compatibility first

 Build the protocol shell before porting the runtime. This validates the central architectural
 assumption early.

 2.1 Add the Chat Completions route

 Suggested path:

 web/app/api/llm/v1/chat/completions/route.ts

 Responsibilities only:

 1. Parse and validate the OpenAI request.
 2. Authenticate the Bearer token.
 3. Call an injected completion engine.
 4. Encode the result as streaming or non-streaming OpenAI output.
 5. Return OpenAI-shaped errors.

 Keep runtime logic out of the route.

 2.2 Support the Pipecat request subset

 The installed Pipecat service sends:

 - model
 - messages
 - tools
 - tool_choice
 - stream: true
 - stream_options.include_usage
 - Sampling/token settings

 Support message roles:

 - system
 - developer
 - user
 - assistant
 - tool

 Set request limits for:

 - Message count
 - Total text size
 - Tool count
 - Tool-schema size
 - Tool-result size

 2.3 Implement compliant SSE encoding

 For ordinary text:

 - Initial assistant-role chunk
 - One or more content chunks
 - Final chunk with finish_reason: "stop"
 - Usage chunk
 - [DONE]

 For tools:

 - Stable tool-call ID
 - delta.tool_calls[index]
 - Function name
 - JSON argument fragments
 - finish_reason: "tool_calls"
 - Usage chunk
 - [DONE]

 The initial implementation can emit validated content in one SSE content chunk. It remains
 protocol-compatible without pretending to offer low-latency token streaming.

 2.4 Build the decisive integration test

 Use the actual Python components installed in agent/.venv:

 1. Instantiate Pipecat OpenAILLMService with the custom base URL.
 2. Register a normal FunctionSchema handler.
 3. Submit a context containing that tool.
 4. Have the endpoint return a tool call.
 5. Verify Pipecat invokes the handler.
 6. Verify Pipecat sends the tool result back.
 7. Verify the endpoint returns final assistant text.

 Also test:

 - Split argument fragments
 - Invalid JSON arguments
 - Missing handler
 - tool_choice: none
 - tool_choice: required
 - Named tool choice
 - Multiple returned tool results
 - Tool cancellation
 - Async-tool developer messages

 Acceptance

 An unchanged Pipecat OpenAILLMService successfully completes:

 ```text
   user → custom provider → tool_call → local handler
        → tool result → custom provider → assistant speech
 ```

 Do not proceed with the runtime port until this passes.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 3 — Make web the canonical spec compiler

 3.1 Reuse the existing Zod schemas

 Start from:

 web/lib/spec-draft-schema.ts

 Do not create a competing third schema. Extend it only where runtime fields are missing:

 - Persona runtime schema
 - Compiled phase schema
 - Namespaced evidence keys
 - Runtime state schema
 - Analysis schema
 - Action schema
 - Claim and provenance schemas

 3.2 Port build_specs()

 Port the behavior from agent/interview.py:

 - Deep-merge global and stage configuration
 - Validate unique stage IDs
 - Namespace evidence as <stage>.<key>
 - Validate completion keys
 - Validate turn bounds
 - Validate allowed/default actions
 - Validate rendering limits
 - Preserve hidden scenario facts
 - Resolve inherited tools and knowledge settings
 - Verify Agent/Domain match
 - Preserve database versions

 3.3 Validate at publication time

 Currently Python performs the authoritative validation at session startup. Move that validation into
 the web publish path so an invalid spec cannot become runnable.

 Drafts may remain invalid while editing, but:

 - Preview must show compilation errors.
 - Publishing must require successful compilation.
 - Production session activation must only use compiled specs.

 3.4 Pin a compiled session snapshot

 When activating a session, store an immutable runtime snapshot containing:

 - Persona data/version
 - Agent data/version
 - Domain data/version
 - Resolved phases
 - Qualified evidence definitions
 - Knowledge grounding rules
 - Knowledge-base IDs
 - Rendering rules
 - Prompt versions
 - Controller version
 - Runtime-state schema version
 - Upstream model configuration
 - Context document identity/hash

 Do not reload current mutable spec rows on every completion.

 Acceptance

 - Every current YAML agent/persona combination compiles.
 - Existing malformed-spec cases fail identically.
 - Editing a published spec does not affect an active session.
 - Draft preview can pin a specific draft revision.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 4 — Add durable runtime state and idempotency

 OpenAI clients and networks retry requests. The provider must not grade twice.

 4.1 Extend the session record

 Conceptually add:

 - Compiled runtime snapshot
 - Runtime state
 - Runtime revision
 - Runtime/controller version
 - Current logical turn ID
 - Started/completed timestamps already present

 Index the runtime-token hash so the OpenAI endpoint can resolve a session directly from the Bearer
 token.

 4.2 Add a logical runtime-turn record

 A learner turn may span several Chat Completion requests because of tools.

 Store:

 - Logical turn ID
 - Session ID
 - Base session revision
 - Root context fingerprint
 - Learner input
 - Status:
     - processing
     - awaiting tool
     - rendering
     - completed
     - cancelled
     - failed
 - Raw/applied analysis
 - Draft state
 - Selected action
 - Retrieval hits
 - Pending tool calls
 - Received tool results
 - Final response
 - Usage and timings

 4.3 Cache individual Chat Completion responses

 For every OpenAI request, compute a canonical request hash from:

 - Session identity
 - Model
 - Messages
 - Tools
 - Tool choice
 - Relevant generation settings

 Exclude transport-only fields such as stream; cache the semantic result and encode it as either SSE
 or JSON.

 A repeated request must return:

 - Identical content
 - Identical tool-call IDs
 - Identical arguments
 - Identical finish reason

 4.4 Associate tool continuations correctly

 Define the logical-turn root as the conversation through the latest user message.

 When subsequent requests append:

 - Assistant tool calls
 - role: tool results
 - Pipecat async-tool developer messages

 they remain part of the same logical turn.

 A second identical learner utterance later remains distinguishable because the preceding context
 differs.

 4.5 Use compare-and-swap persistence

 Do not hold a Postgres transaction during model calls.

 Flow:

 1. Read session state and revision.
 2. Claim/create the logical turn.
 3. Perform retrieval and model work.
 4. Persist the completion result.
 5. Commit final session state only if its revision is unchanged.
 6. Replay cached output on duplicate requests.
 7. Reject genuinely stale competing transitions.

 Acceptance

 - Retrying the initial completion does not double-grade.
 - Retrying a tool request returns the same tool-call ID.
 - Replaying a tool result does not execute another transition.
 - Two concurrent learner turns cannot both advance the same revision.
 - A spec edit cannot alter an in-progress session.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 5 — Port the deterministic runtime to web

 Suggested module boundary:

 ```text
   web/lib/interview-runtime/
     schema.ts
     compiler.ts
     controller.ts
     prompts.ts
     model.ts
     runtime.ts
     openai.ts
 ```

 Keep these modules boring; do not build a framework.

 5.1 Port pure controller functions

 Port from agent/runner.py:

 - Active phase/evidence/scenario resolution
 - Allowed/default action resolution
 - Next-evidence selection
 - Analysis validation
 - Evidence application
 - Probe exhaustion
 - Phase expiration
 - Grounding-target selection
 - Closing action
 - Action selection
 - Feedback summary
 - Action validation
 - Render validation
 - Deterministic response fallback
 - Retrieval-skipping rules
 - Relevant-context selection

 These should contain no database, network, or model calls.

 5.2 Port structured analyzer behavior

 Use the existing OpenRouter request pattern and Zod validation.

 Preserve:

 - Structured AnswerAnalysis
 - Exact learner-quote requirement
 - At most two evidence updates
 - Active-phase key filtering
 - Execution-result trust restriction
 - Claim provenance
 - Separate claim-handling policies
 - Resume-context boundaries
 - Retry-once behavior
 - Raw versus applied analysis recording

 Do not change prompts while porting. Prompt improvements come after parity.

 5.3 Move retrieval into the runtime

 Call web libraries directly rather than calling the existing HTTP search route from within web:

 - MainCollectionService.searchKnowledge
 - MainCollectionService.searchPersonaVoice
 - Existing legacy fallback where still required

 Preserve current behavior:

 - Retrieval before grading
 - Per-stage enable/disable
 - Stage-specific grounding configuration
 - Knowledge-base allowlists
 - Top-three knowledge hits
 - Persona voice retrieval degrades gracefully
 - Knowledge retrieval failure blocks grading

 Do not port the local hashing-based KnowledgeIndex.

 5.4 Port renderer behavior

 The renderer receives:

 - Deterministically selected action
 - Active phase
 - Current evidence
 - Persona rules
 - Retrieved knowledge
 - Persona voice examples
 - Recent canonical transcript
 - Available and permitted Pipecat tools

 The renderer may produce either:

 - Assistant text
 - A tool call

 Text still goes through:

 1. Validation
 2. One repair attempt
 3. Deterministic fallback

 5.5 Add deterministic tool gating

 Calculate callable tools as:

 ```text
   tools advertised by Pipecat
   ∩ tools allowed by the compiled scenario
   ∩ tools allowed in the current phase
 ```

 Rules:

 - Never emit an unadvertised tool.
 - Never emit a stage-forbidden tool.
 - Validate the tool name and arguments.
 - For a deterministic tool action, force the mapped named tool.
 - For ordinary conversation, expose only stage-approved opportunistic tools.
 - If tool_choice: none, emit text only.
 - If a named/required choice conflicts with scenario policy, return a clear OpenAI-shaped error.

 The underlying renderer model may receive the filtered tool schemas and produce a normal tool call.
 The web runtime remains the policy gate.

 5.6 Handle tool results

 When Pipecat returns tool output:

 - Match exact pending tool-call ID and name.
 - Reject unknown, duplicate, expired, or cancelled calls.
 - Validate the result according to the expected tool.
 - Apply a tool-specific state reducer.
 - Do not rerun learner analysis.
 - Continue the deterministic action flow.
 - Render text, request another tool, or close.

 Trusted code execution results may update execution_result; spoken or arbitrary browser claims may
 not.

 Acceptance

 - Golden controller fixtures match Python behavior.
 - Recorded sessions produce the same action/state progression.
 - Knowledge and context boundaries remain intact.
 - Tool calls cannot bypass stage policy.
 - Invalid rendered responses still repair/fallback safely.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 6 — Convert Pipecat back to a standard LLM pipeline

 6.1 Bind session identity before constructing the pipeline

 The browser already creates the web session before opening WebRTC.

 Use SmallWebRTCTransport’s supported webrtcRequestParams.requestData to send:

 - Session ID
 - Session runtime token

 Pipecat exposes that as SmallWebRTCRunnerArguments.body, so the agent can construct OpenAILLMService
  with the session token before the first inference.

 Security requirement: ensure Pipecat/FastAPI logs never print the runtime token. If framework
 logging cannot be safely redacted, use a short-lived one-time connection ticket that the agent
 exchanges for the runtime credential.

 The later start-interview RTVI message can then be removed or retained temporarily only for
 migration compatibility.

 6.2 Replace InterviewBrainProcessor

 Replace it with standard Pipecat OpenAILLMService configured against:

 ```text
   base_url = <WEB_URL>/api/llm/v1
   api_key  = <session runtime token>
   model    = trainertwin-runtime
 ```

 Keep:

 - VAD
 - SmartTurn
 - STT
 - TTS
 - Context aggregators
 - Interruptions
 - Recording
 - WebRTC output filtering
 - Closing audio gate
 - Workspace bridge

 6.3 Register normal Pipecat function handlers

 Suggested new module:

 agent/tools.py

 Handlers should use Pipecat’s ordinary function API and always complete through
 params.result_callback().

 Categories:

 ### Workspace tools

 Call WorkspaceBridge.request():

 - Code editor state
 - Selection/range
 - Run code
 - Get output
 - Canvas scene and edits
 - Presentation navigation/search

 ### Surface tools

 Call WorkspaceBridge.command():

 - Open code editor
 - Open whiteboard
 - Open PDF
 - Open presentation
 - Close surface

 ### Realtime tools

 Run locally:

 - Finish session
 - Possibly mute/unmute or transfer later

 Tool handlers must:

 - Be idempotent where side effects matter
 - Honor Pipecat cancellation
 - Set appropriate timeouts
 - Return structured JSON
 - Never update assessment state directly

 The tool result goes back to the web provider, which owns assessment consequences.

 6.4 Register one trusted superset

 Initially register all trusted handlers required by that session. Let web phase policy decide which
 ones may be called.

 Avoid phase-driven LLMSetToolsFrame changes until tool-schema size or confusion is measured.

 6.5 Handle the opening through the provider

 Initialize the LLM context with a controlled developer message such as a session-start event and
 trigger the first inference.

 For a session with no prior turns, the provider should return the pinned deterministic opening
 without calling the analyzer.

 The assistant aggregator then records it normally.

 6.6 Handle closing through a Pipecat tool

 Register a local finish_session function.

 Recommended sequence:

 1. Provider emits finish_session.
 2. Handler marks the next response as closing and returns a tool result.
 3. Pipecat calls the provider again.
 4. Provider returns deterministic closing text.
 5. Closing processor wraps that response in the existing closing boundaries.
 6. ClosingGate waits for actual TTS audio completion.
 7. Agent finalizes the web session and disconnects.

 This preserves normal tool calling while retaining correct audio-delivery behavior.

 Acceptance

 - No InterviewBrainProcessor is involved in LLM inference.
 - Ordinary Pipecat handlers execute from provider-emitted tool calls.
 - Interruption cancels configured tools normally.
 - Opening, regular response, tool loop, and closing all pass through standard Pipecat frames.
 - STT/TTS and recording behavior are unchanged.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 7 — Move UI state to the web control plane

 The OpenAI response must remain standard; do not add private coverage fields to completion chunks.

 7.1 Make Postgres authoritative per turn

 Web writes:

 - Transcript
 - Evidence
 - Phase
 - Decisions
 - Retrieval trace
 - Tool history

 The browser’s disconnect finalizer should stop overwriting authoritative transcript/evidence. It may
 only submit audio/client-delivery metadata or fill missing emergency data.

 7.2 Update the browser from web

 Initially, after a finalized bot output, fetch the current session runtime snapshot directly from
 web:

 - Coverage
 - Phase
 - Status
 - Current surface where appropriate

 Use polling/fetch first. Add SSE only if measured responsiveness requires it.

 7.3 Keep surface execution through Pipecat

 Workspace commands and results still travel through RTVI because Pipecat owns the registered
 handlers. Only assessment state comes directly from web.

 Acceptance

 - Browser coverage equals persisted runtime state.
 - Disconnect cannot replace a richer canonical transcript with partial client data.
 - UI remains correct after page reconnect.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 8 — Build the text playground

 8.1 Use the OpenAI endpoint as an external client

 The text playground should use the same provider contract, not bypass it by importing the runtime
 directly.

 It should:

 - Create a preview session/token
 - Pin a published spec or exact draft revision
 - Submit standard Chat Completion messages
 - Execute returned tools
 - Return tool results through the same protocol
 - Render final responses

 8.2 Add a protected diagnostic panel

 Show:

 - Raw/applied analysis
 - Rejected evidence updates
 - State before/after
 - Selected action and reason
 - Retrieved sources
 - Tool request/result
 - Renderer validation
 - Prompt/controller/model versions
 - Latency and token usage

 Keep this unavailable to learners in production.

 8.3 Support iteration controls

 - Reset session
 - Fork from a previous turn
 - Switch draft revision
 - Replay a transcript
 - Compare two spec revisions
 - Export a failing trace as a regression fixture

 Acceptance

 - The same session trace through text and Pipecat produces the same deterministic state/action
   sequence.
 - Unpublished drafts are testable without publishing.
 - A failing playground trace can become an automated fixture.

 ────────────────────────────────────────────────────────────────────────────────

 Phase 9 — Operational hardening

 Security

 - Bearer token resolves exactly one active session.
 - Token hashes are indexed and never logged.
 - Request body and tool-result size limits.
 - Per-session rate limits.
 - Tool name/argument/result validation.
 - Debug traces protected by organization/admin authorization.
 - Context and retrieved data treated as untrusted prompt input.
 - Runtime token revoked only after proper session completion.

 Reliability

 - Explicit upstream model timeouts.
 - Request cancellation passed to retrieval/model fetches.
 - Retry only stateless internal model failures.
 - Completion caching before SSE begins.
 - Stable tool-call IDs across retries.
 - Stale tool results rejected.
 - Web outage returns retryable OpenAI errors rather than an agent-side fallback model.

 Latency

 Measure separately:

 - STT finalization
 - Agent → web
 - Session/spec load
 - Embedding and Chroma
 - Analyzer
 - Controller
 - Renderer
 - Web → agent
 - TTS first audio

 Keep reranking disabled in the voice path unless quality justifies its cost.

 Deployment compatibility

 Persist:

 - Runtime schema version
 - Controller version
 - Analyzer prompt version
 - Renderer prompt version
 - Model alias and upstream model

 Controller releases must read active-session state from the previous compatible version. Breaking
 migrations should wait for active sessions to drain or provide a state migration.

 OpenAI conformance

 Test with:

 - Official Python OpenAI client
 - Pipecat OpenAILLMService
 - Streaming and non-streaming
 - Sync and async tools
 - Tool cancellation
 - Tool errors
 - Usage chunks
 - Malformed requests
 - Connection interruption

 ────────────────────────────────────────────────────────────────────────────────

 Phase 10 — Rollout and cleanup

 Rollout order

 1. Deploy nullable database additions.
 2. Deploy OpenAI endpoint without production traffic.
 3. Run OpenAI and Pipecat conformance tests.
 4. Deploy canonical spec compiler and runtime.
 5. Run text playground against draft and published specs.
 6. Replay recorded Python sessions against the web runtime.
 7. Add an agent environment flag:
     - legacy
     - web-openai
 8. Canary one non-production/controlled voice scenario.
 9. Compare state, tool calls, latency, and failure rates.
 10. Switch all voice sessions.
 11. Retain legacy mode for one release.
 12. Remove legacy code and dependencies.

 Agent cleanup after cutover

 Remove runtime/domain responsibilities from:

 - agent/interview.py
 - agent/runner.py

 Remove no-longer-needed direct dependencies where verified:

 - Pydantic AI
 - ChromaDB
 - libSQL
 - YAML
 - document loaders
 - local runtime storage

 Keep:

 - Pipecat
 - STT/TTS
 - HTTP client
 - WebRTC
 - recording
 - workspace bridge
 - tool handlers

 Update:

 - agent/bot.py
 - agent/pyproject.toml
 - agent/Dockerfile
 - agent/stack.yml
 - .env.example
 - README and deployment docs

 Before implementation, isolate the existing unrelated uncommitted changes in copilot/ and web/ so
 this migration does not overwrite them.

 ────────────────────────────────────────────────────────────────────────────────

 Definition of done

 The migration is complete when:

 - Standard Pipecat OpenAILLMService works by pointing at the web base URL.
 - Pipecat function tools execute without a custom LLM service.
 - Tool results return to the provider and produce the correct next response.
 - Chroma, specs, prompts, controller state, and decisions live only in web.
 - Voice and text use the same OpenAI endpoint.
 - Sessions pin immutable compiled revisions.
 - Duplicate/retried requests cannot duplicate grading or tools.
 - Current deterministic controller behavior is covered in web tests.
 - Pipecat contains no evidence, phase, grading, or retrieval logic.
 - Postgres—not SQLite, browser state, or Pipecat memory—is the authoritative session record.
 - Opening, tools, interruptions, errors, closing audio, recording, and reconnect behavior all have
   integration coverage.

 Explicitly deferred

 - OpenAI Responses API
 - Embeddings/audio/files API compatibility
 - True token streaming before validation
 - Parallel tool emission
 - A separate runtime microservice
 - Changing prompts or grading policy during the migration
 - Delivery-aware evidence accounting beyond current semantics
