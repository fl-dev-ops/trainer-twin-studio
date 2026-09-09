  Implementation Plan: OpenAI-Compatible Interview LLM Endpoint

  ────────────────────────────────────────

  Overview

  Goal: Create a /api/v1/chat/completions endpoint in web/ that:
  • Accepts standard OpenAI chat completion requests
  • Internally runs spec-driven interview logic (analyze → select_action → render)
  • Returns standard OpenAI responses (with optional tool_calls)
  • Enables text-based testing without voice

  Result: Pipecat agent becomes a thin voice layer; all interview intelligence lives in web.

  ────────────────────────────────────────

  Phase 1: API Contract & Foundation

  1.1 Create OpenAI-Compatible Route Structure

  web/
  ├── app/
  │   └── api/
  │       └── v1/
  │           ├── chat/
  │           │   └── completions/
  │           │       └── route.ts        # Main endpoint
  │           ├── models/
  │           │   └── route.ts            # List available "models"
  │           └── sessions/
  │               └── [id]/
  │                   └── state/
  │                       └── route.ts    # Get session state for UI

  1.2 Define TypeScript Types

  // web/lib/interview/types.ts
  // OpenAI Request Types
  interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    tools?: Tool[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
  }
  interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;  // For tool results
  }
  interface Tool {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }
  interface ToolCall {
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;  // JSON string
    };
  }
  // OpenAI Response Types
  interface ChatCompletionResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }
  interface ChatCompletionChoice {
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: "stop" | "tool_calls" | "length";
  }
  // Streaming chunk type
  interface ChatCompletionChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: [{
      index: number;
      delta: {
        role?: "assistant";
        content?: string;
        tool_calls?: ToolCall[];
      };
      finish_reason: "stop" | "tool_calls" | null;
    }];
  }

  1.3 Session Identification Strategy

  // Extract session from request
  function extractSessionId(req: Request, body: ChatCompletionRequest): string {
    // Option 1: Custom header (preferred)
    const headerSession = req.headers.get("X-Session-ID");
    if (headerSession) return headerSession;

    // Option 2: Model name encoding (fallback)
    // model: "trainertwin/session_abc123"
    const match = body.model.match(/^trainertwin\/(.+)$/);
    if (match) return match[1];

    throw new Error("Session ID required via X-Session-ID header or model name");
  }
  function extractRuntimeToken(req: Request): string {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      throw new Error("Authorization required");
    }
    return auth.slice(7);
  }

  1.4 Basic Endpoint Skeleton

  // web/app/api/v1/chat/completions/route.ts
  import { NextRequest } from "next/server";
  export async function POST(req: NextRequest) {
    const body = await req.json();
    const sessionId = extractSessionId(req, body);
    const token = extractRuntimeToken(req);

    // Validate session access
    const session = await validateSession(sessionId, token);
    if (!session) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }

    // Extract latest user message
    const userMessage = extractLatestUserMessage(body.messages);

    // Check for tool results in messages
    const toolResults = extractToolResults(body.messages);

    if (body.stream) {
      return streamingResponse(session, userMessage, toolResults);
    } else {
      return blockingResponse(session, userMessage, toolResults);
    }
  }

  Deliverables - Phase 1

  ◻ Route structure created
  ◻ TypeScript types defined
  ◻ Session extraction working
  ◻ Basic request/response flow (echo mode)
  ◻ Streaming SSE skeleton

  ────────────────────────────────────────

  Phase 2: Core Interview Logic (TypeScript Port)

  2.1 Port Spec Types from Python

  Map runner.py Pydantic models to TypeScript/Zod:

  // web/lib/interview/specs.ts
  import { z } from "zod";
  // Already exists in web/lib/spec-draft-schema.ts - extend/reuse
  export const evidenceStatusSchema = z.enum([
    "untested", "partial", "sufficient", "weak", "unresolved"
  ]);
  export const classificationSchema = z.enum([
    "strong", "partial", "vague", "unsupported",
    "contradictory", "unknown", "role_violation"
  ]);
  export const learnerIntentSchema = z.enum([
    "answer", "question", "clarification", "stop"
  ]);
  // Evidence update from analysis
  export const evidenceUpdateSchema = z.object({
    key: z.string(),
    status: z.enum(["partial", "sufficient"]),
    evidence: z.string(),
    quote: z.string(),
    provenance: z.enum([
      "context_declared", "observed_incident",
      "supported_elaboration", "unverified_elaboration", "hypothetical"
    ]),
  });
  // Analysis result
  export const answerAnalysisSchema = z.object({
    classification: classificationSchema,
    learner_intent: learnerIntentSchema,
    valid_evidence: z.array(z.string()),
    evidence_updates: z.array(evidenceUpdateSchema),
    unresolved_point: z.string(),
    unresolved_evidence_key: z.string().nullable(),
    contradiction: z.string().nullable(),
    important_term: z.string().nullable(),
  });
  // Interview action
  export const interviewActionSchema = z.object({
    name: z.string(),
    evidence_key: z.string().nullable(),
    reason: z.string(),
    intent: z.string(),
    fallback_text: z.string().nullable(),
    close: z.boolean(),
    expects_answer: z.boolean(),
  });

  2.2 Port Session State Management

  // web/lib/interview/session-state.ts
  export interface InterviewState {
    phase_index: number;
    phase_turns: number;
    learner_turns: number;
    coverage: Record<string, EvidenceStatus>;
    evidence: Record<string, EvidenceEntry[]>;
    actions: string[];
    evidence_probe_counts: Record<string, number>;
    pending_evidence_key: string;
    focus: {
      question?: string;
      classification?: string;
      valid_evidence?: string[];
      unresolved_point?: string;
    };
    end_reason?: string;
  }
  // Load state from Prisma InterviewSession
  export async function loadSessionState(sessionId: string): Promise<{
    state: InterviewState;
    config: CompiledConfig;
    messages: TranscriptMessage[];
  }> {
    const session = await db.interviewSession.findUnique({
      where: { id: sessionId },
      include: { agent: { include: { persona: true } } },
    });
    // ... compile config, parse state
  }
  // Save state after turn
  export async function saveSessionState(
    sessionId: string,
    state: InterviewState,
    newMessages: TranscriptMessage[]
  ): Promise<void> {
    await db.interviewSession.update({
      where: { id: sessionId },
      data: {
        state: state as any,
        transcript: { push: newMessages },
      },
    });
  }

  2.3 Port Analysis Logic

  // web/lib/interview/analyze.ts
  import { generateObject } from "ai";
  import { openai } from "@ai-sdk/openai";
  export async function analyzeAnswer(
    learnerText: string,
    transcript: TranscriptMessage[],
    state: InterviewState,
    agent: CompiledAgent,
    domain: CompiledDomain,
    knowledge: KnowledgeHit[],
  ): Promise<{
    raw: AnswerAnalysis;
    applied: AnswerAnalysis;
    corrections: string[];
  }> {
    const phase = agent.phases[state.phase_index];
    const required = getActiveEvidence(agent, state);

    const prompt = buildAnalysisPrompt({
      learnerText,
      transcript,
      state,
      agent,
      domain,
      phase,
      required,
      knowledge,
    });

    const { object: raw } = await generateObject({
      model: openai("gpt-4.1-mini"),  // Or your configured model
      schema: answerAnalysisSchema,
      prompt,
    });

    const { applied, corrections } = validateAnalysis(raw, agent, state, learnerText);
    return { raw, applied, corrections };
  }

  2.4 Port Action Selection (Deterministic)

  // web/lib/interview/select-action.ts
  export function selectAction(
    analysis: AnswerAnalysis,
    state: InterviewState,
    persona: CompiledPersona,
    agent: CompiledAgent,
  ): InterviewAction {
    const phase = agent.phases[state.phase_index];
    const required = getActiveEvidence(agent, state);
    const defaultAction = getActiveDefaultAction(agent, state);

    // Handle stop intent
    if (analysis.learner_intent === "stop") {
      return closingAction(state, agent);
    }

    // Handle questions/clarifications
    if (analysis.learner_intent === "question" || analysis.learner_intent === "clarification") {
      return handleLearnerQuestion(analysis, state, agent, required);
    }

    // Apply evidence updates
    applyEvidenceUpdates(analysis, state, required);

    // Check phase/session completion
    if (shouldCloseSession(state, agent)) {
      return closingAction(state, agent);
    }

    if (shouldTransitionPhase(state, agent)) {
      return transitionPhaseAction(state, agent);
    }

    // Select probing action based on classification
    return selectProbingAction(analysis, state, persona, agent);
  }

  2.5 Port Rendering Logic

  // web/lib/interview/render.ts
  export async function renderResponse(
    action: InterviewAction,
    transcript: TranscriptMessage[],
    persona: CompiledPersona,
    agent: CompiledAgent,
    domain: CompiledDomain,
    knowledge: KnowledgeHit[],
    state: InterviewState,
    personaVoice: PersonaVoiceHit[],
  ): Promise<{ text: string; events: RenderEvent[] }> {
    // Closing actions use deterministic text
    if (action.close) {
      return {
        text: action.fallback_text || getDeterministicFallback(action, agent, state),
        events: []
      };
    }

    const prompt = buildRenderPrompt({
      action, transcript, persona, agent, domain,
      knowledge, state, personaVoice
    });

    const { text } = await generateText({
      model: openai("gpt-4.1-mini"),
      prompt,
      maxTokens: 500,
      temperature: 0.5,
    });

    // Validate rendered text
    const errors = validateRendered(text, action, agent, state);
    if (errors.length > 0) {
      // Retry once
      const retryText = await retryRender(prompt, errors);
      const retryErrors = validateRendered(retryText, action, agent, state);
      if (retryErrors.length > 0) {
        return {
          text: getDeterministicFallback(action, agent, state),
          events: [{ fallback: true }]
        };
      }
      return { text: retryText, events: [{ retry: true }] };
    }

    return { text, events: [] };
  }

  2.6 Knowledge Retrieval (Consolidate)

  // web/lib/interview/knowledge.ts
  // Reuse existing web/lib/org-knowledge.ts
  export async function retrieveKnowledge(
    sessionId: string,
    state: InterviewState,
    agent: CompiledAgent,
    learnerText: string,
    orgId: string,
  ): Promise<KnowledgeHit[]> {
    const phase = agent.phases[state.phase_index];

    if (!phase.retrieval || phase.claim_handling === "session_feedback") {
      return [];
    }

    const query = buildKnowledgeQuery(phase, state, learnerText);
    const kbs = getActiveKnowledgeBases(agent, phase);

    return queryKnowledge(orgId, kbs, query, { limit: 3 });
  }
  export async function retrievePersonaVoice(
    personaId: string,
    action: InterviewAction,
    query: string,
    orgId: string,
  ): Promise<PersonaVoiceHit[]> {
    return queryPersonaVoice(orgId, personaId, action.name, query, { limit: 4 });
  }

  Deliverables - Phase 2

  ◻ Spec types ported to TypeScript/Zod
  ◻ Session state load/save working
  ◻ analyze() function ported
  ◻ selectAction() function ported (deterministic)
  ◻ render() function ported
  ◻ Knowledge retrieval consolidated
  ◻ Unit tests for each function

  ────────────────────────────────────────

  Phase 3: Tool Integration & Session Close

  3.1 Define Standard Tools

  // web/lib/interview/tools.ts
  export const INTERVIEW_TOOLS: Tool[] = [
    {
      type: "function",
      function: {
        name: "open_code_editor",
        description: "Open a code editor for the candidate to write code",
        parameters: {
          type: "object",
          properties: {
            language: {
              type: "string",
              description: "Programming language (python, javascript, etc.)",
              default: "python"
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "open_whiteboard",
        description: "Open a whiteboard for diagramming and visual explanations",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: "run_code",
        description: "Execute code in the sandbox and return results",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "Code to execute" },
            language: { type: "string", default: "python" }
          },
          required: ["code"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "end_session",
        description: "End the interview session gracefully",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              enum: ["completed", "user_stop", "time_limit"]
            }
          }
        }
      }
    }
  ];

  3.2 Tool Decision Logic

  // web/lib/interview/tool-decisions.ts
  export function decideToolCalls(
    action: InterviewAction,
    state: InterviewState,
    agent: CompiledAgent,
  ): ToolCall[] {
    const tools: ToolCall[] = [];
    const phase = agent.phases[state.phase_index];

    // Check if phase requires a surface
    const surface = getSurfaceForPhase(phase);
    if (surface && !state.surface_opened) {
      if (surface.action === "open_code_editor") {
        tools.push({
          id: `call_${crypto.randomUUID().slice(0, 8)}`,
          type: "function",
          function: {
            name: "open_code_editor",
            arguments: JSON.stringify({ language: surface.payload.language })
          }
        });
      } else if (surface.action === "open_whiteboard") {
        tools.push({
          id: `call_${crypto.randomUUID().slice(0, 8)}`,
          type: "function",
          function: {
            name: "open_whiteboard",
            arguments: "{}"
          }
        });
      }
    }

    // Check for session close
    if (action.close) {
      tools.push({
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: "end_session",
          arguments: JSON.stringify({ reason: state.end_reason || "completed" })
        }
      });
    }

    return tools;
  }

  3.3 Handle Tool Results

  // web/lib/interview/tool-results.ts
  export function processToolResults(
    messages: ChatMessage[],
    state: InterviewState,
  ): { updated: boolean; state: InterviewState } {
    const toolMessages = messages.filter(m => m.role === "tool");
    let updated = false;

    for (const msg of toolMessages) {
      const result = JSON.parse(msg.content || "{}");

      // Track that surface was opened
      if (msg.tool_call_id?.includes("open_code_editor") ||
          msg.tool_call_id?.includes("open_whiteboard")) {
        state.surface_opened = true;
        updated = true;
      }

      // Handle code execution results
      if (result.execution_result) {
        state.last_execution_result = result.execution_result;
        updated = true;
      }
    }

    return { updated, state };
  }

  3.4 Complete Endpoint Implementation

  // web/app/api/v1/chat/completions/route.ts
  export async function POST(req: NextRequest) {
    try {
      const body: ChatCompletionRequest = await req.json();
      const sessionId = extractSessionId(req, body);
      const token = extractRuntimeToken(req);

      // Load session
      const { state, config, messages: transcript } = await loadSession(sessionId, token);

      // Process any tool results from previous turn
      const { state: updatedState } = processToolResults(body.messages, state);

      // Extract latest user message
      const userMessage = extractLatestUserMessage(body.messages);
      if (!userMessage) {
        // No new user input - might be just tool results
        return buildEmptyResponse(body.model);
      }

      // Main interview step
      const result = await interviewStep(userMessage, updatedState, config, transcript);

      // Save updated state
      await saveSessionState(sessionId, result.state, [
        { role: "user", text: userMessage },
        { role: "assistant", text: result.response },
      ]);

      // Build response
      if (body.stream) {
        return streamResponse(result, body.model);
      } else {
        return jsonResponse(result, body.model);
      }

    } catch (error) {
      return Response.json(
        { error: { message: error.message, type: "api_error" } },
        { status: 500 }
      );
    }
  }
  async function interviewStep(
    userMessage: string,
    state: InterviewState,
    config: CompiledConfig,
    transcript: TranscriptMessage[],
  ): Promise<StepResult> {
    const { persona, agent, domain, knowledgeBases, orgId } = config;

    // 1. Retrieve knowledge
    const knowledge = await retrieveKnowledge(
      state, agent, userMessage, orgId, knowledgeBases
    );

    // 2. Analyze
    const { applied: analysis } = await analyzeAnswer(
      userMessage, transcript, state, agent, domain, knowledge
    );

    // 3. Select action (deterministic)
    const action = selectAction(analysis, state, persona, agent);

    // 4. Retrieve persona voice (if not closing)
    const personaVoice = action.close ? [] : await retrievePersonaVoice(
      persona.id, action, buildVoiceQuery(action, analysis, userMessage), orgId
    );

    // 5. Render response
    const { text: response } = await renderResponse(
      action, transcript, persona, agent, domain, knowledge, state, personaVoice
    );

    // 6. Update state
    const newState = updateState(state, analysis, action);

    // 7. Decide tool calls
    const toolCalls = decideToolCalls(action, newState, agent);

    return {
      response,
      state: newState,
      action,
      toolCalls,
      close: action.close,
    };
  }

  3.5 Streaming Implementation

  // web/lib/interview/streaming.ts
  export function streamResponse(result: StepResult, model: string): Response {
    const encoder = new TextEncoder();
    const id = `chatcmpl-${crypto.randomUUID()}`;

    const stream = new ReadableStream({
      async start(controller) {
        // Send role
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            id, object: "chat.completion.chunk", model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
          })}\n\n`
        ));

        // Stream content word by word (or use actual LLM streaming)
        const words = result.response.split(" ");
        for (const word of words) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              id, object: "chat.completion.chunk", model,
              choices: [{ index: 0, delta: { content: word + " " }, finish_reason: null }]
            })}\n\n`
          ));
          await sleep(20); // Simulate streaming pace
        }

        // Send tool calls if any
        if (result.toolCalls.length > 0) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              id, object: "chat.completion.chunk", model,
              choices: [{ index: 0, delta: { tool_calls: result.toolCalls }, finish_reason:
  "tool_calls" }]
            })}\n\n`
          ));
        } else {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              id, object: "chat.completion.chunk", model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}\n\n`
          ));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  Deliverables - Phase 3

  ◻ Tool definitions created
  ◻ Tool decision logic implemented
  ◻ Tool result processing working
  ◻ Session close via end_session tool
  ◻ Streaming response working
  ◻ Non-streaming response working

  ────────────────────────────────────────

  Phase 4: Testing & Validation

  4.1 Text Chat UI for Testing

  // web/app/interview-test/page.tsx
  "use client";
  import { useState } from "react";
  export default function InterviewTestPage() {
    const [sessionId, setSessionId] = useState("");
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");

    async function sendMessage() {
      const response = await fetch("/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": sessionId,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: "trainertwin",
          messages: [...messages, { role: "user", content: input }],
          tools: INTERVIEW_TOOLS,
        }),
      });

      const data = await response.json();
      // Update UI with response
    }

    return (
      <div className="flex flex-col h-screen">
        {/* Chat UI */}
      </div>
    );
  }

  4.2 API Compatibility Tests

  // web/lib/interview/__tests__/api-compatibility.test.ts
  describe("OpenAI API Compatibility", () => {
    it("accepts standard chat completion request", async () => {
      const response = await fetch("/api/v1/chat/completions", {
        method: "POST",
        headers: { "X-Session-ID": testSessionId, "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          model: "trainertwin",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toHaveProperty("choices");
      expect(data.choices[0]).toHaveProperty("message");
      expect(data.choices[0].message).toHaveProperty("role", "assistant");
    });

    it("streams SSE correctly", async () => {
      const response = await fetch("/api/v1/chat/completions", {
        method: "POST",
        headers: { "X-Session-ID": testSessionId, "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          model: "trainertwin",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      });

      expect(response.headers.get("content-type")).toBe("text/event-stream");
      // Parse SSE and validate chunks
    });

    it("returns tool_calls when appropriate", async () => {
      // Test with a session that should trigger code editor
    });
  });

  4.3 Interview Logic Tests

  // web/lib/interview/__tests__/select-action.test.ts
  describe("selectAction", () => {
    it("returns closing action when learner says stop", () => {
      const analysis = { learner_intent: "stop", /* ... */ };
      const action = selectAction(analysis, state, persona, agent);
      expect(action.close).toBe(true);
      expect(action.name).toBe("close_session");
    });

    it("transitions phase when phase is complete", () => {
      const state = { phase_index: 0, phase_turns: 5, /* coverage complete */ };
      const action = selectAction(analysis, state, persona, agent);
      expect(action.name).toBe("transition_phase");
      expect(state.phase_index).toBe(1);
    });

    // ... more tests for each action type
  });

  4.4 Comparison Testing

  // Compare Python and TypeScript implementations produce same results
  describe("Python parity", () => {
    const testCases = loadTestCases("interview-test-cases.json");

    for (const testCase of testCases) {
      it(`matches Python output for: ${testCase.name}`, async () => {
        const tsResult = await interviewStep(
          testCase.input, testCase.state, testCase.config
        );

        expect(tsResult.action.name).toBe(testCase.expected.action);
        expect(tsResult.state.coverage).toEqual(testCase.expected.coverage);
      });
    }
  });

  Deliverables - Phase 4

  ◻ Text chat UI working
  ◻ API compatibility tests passing
  ◻ Interview logic unit tests
  ◻ Comparison tests with Python implementation
  ◻ Manual testing with various scenarios

  ────────────────────────────────────────

  Phase 5: Agent Migration

  5.1 Update Pipecat Agent

  # agent/bot.py - simplified
  from pipecat.services.openai.llm import OpenAILLMService
  async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
      session_id = None
      runtime_token = None

      # LLM service pointing to your web endpoint
      llm = OpenAILLMService(
          api_key="placeholder",  # Token set per-session
          base_url=os.getenv("WEB_URL") + "/api/v1",
          model="trainertwin",
      )

      # Register tool handlers
      @llm.tool()
      async def open_code_editor(params: FunctionCallParams, language: str = "python"):
          """Open code editor for the candidate."""
          await workspace.command(worker, "surface", {
              "action": "open_code_editor",
              "payload": {"language": language}
          })
          await params.result_callback({"status": "opened", "language": language})

      @llm.tool()
      async def open_whiteboard(params: FunctionCallParams):
          """Open whiteboard for diagramming."""
          await workspace.command(worker, "surface", {
              "action": "open_whiteboard",
              "payload": {}
          })
          await params.result_callback({"status": "opened"})

      @llm.tool()
      async def end_session(params: FunctionCallParams, reason: str = "completed"):
          """End the interview session."""
          await params.result_callback({"status": "ended", "reason": reason})
          await params.llm.push_frame(EndWorkerFrame(), FrameDirection.DOWNSTREAM)

      # Standard Pipecat pipeline
      stt = await make_stt()
      tts = await make_tts()
      context = LLMContext()
      user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context, ...)

      pipeline = Pipeline([
          transport.input(),
          stt,
          user_aggregator,
          llm,
          tts,
          transport.output(),
          assistant_aggregator,
      ])

      # Session start handler
      @worker.rtvi.event_handler("on_client_message")
      async def on_client_message(rtvi, msg):
          nonlocal session_id, runtime_token
          if msg.type == "start-interview":
              session_id = msg.data["sessionId"]
              runtime_token = msg.data["runtimeToken"]

              # Configure LLM with session credentials
              llm._client.api_key = runtime_token
              llm._extra_headers = {"X-Session-ID": session_id}

              # Get opening from web
              opening = await fetch_opening(session_id, runtime_token)
              await llm.push_frame(TTSSpeakFrame(opening))

      # ... rest of pipeline setup

  5.2 Remove Old Python Logic

  Files to delete/archive:
  • agent/interview.py → Archive
  • agent/runner.py → Archive (keep for reference)
  • agent/test_interview.py → Archive
  • agent/test_bot.py → Update for new structure

  5.3 Update Environment

  # agent/.env
  WEB_URL=http://localhost:3000  # Or production URL
  # No longer needed:
  # LLM_API_KEY (web handles this)
  # LLM_BASE_URL (web handles this)

  5.4 Gradual Rollout

  1. Stage 1: Deploy web endpoint, keep Python agent as-is
  2. Stage 2: Add feature flag to switch agent to new endpoint
  3. Stage 3: Test with subset of sessions
  4. Stage 4: Full rollout, remove Python logic

  Deliverables - Phase 5

  ◻ Agent updated to use web endpoint
  ◻ Tool handlers working in Pipecat
  ◻ Session start/end flow working
  ◻ Old Python files archived
  ◻ End-to-end voice testing passing
  ◻ Production deployment

  ────────────────────────────────────────

  File Structure Summary

  web/
  ├── app/
  │   └── api/
  │       └── v1/
  │           ├── chat/completions/route.ts    # Main endpoint
  │           ├── models/route.ts               # List models
  │           └── sessions/[id]/state/route.ts  # State endpoint
  ├── lib/
  │   └── interview/
  │       ├── types.ts              # TypeScript types
  │       ├── specs.ts              # Spec schemas (extend existing)
  │       ├── session-state.ts      # State management
  │       ├── analyze.ts            # Answer analysis
  │       ├── select-action.ts      # Deterministic policy
  │       ├── render.ts             # Response rendering
  │       ├── knowledge.ts          # Knowledge retrieval
  │       ├── tools.ts              # Tool definitions
  │       ├── tool-decisions.ts     # When to call tools
  │       ├── streaming.ts          # SSE streaming
  │       └── __tests__/            # Tests
  agent/
  ├── bot.py                        # Simplified - just Pipecat + tools
  ├── archive/                      # Old logic for reference
  │   ├── interview.py
  │   └── runner.py

  ────────────────────────────────────────
