/**
 * OpenAI Chat Completions runtime adapter.
 * Handles POST /api/v1/chat/completions by delegating to compiler & runtime.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { getAgentConfigForAgent } from "@/lib/specs";
import { searchKnowledge } from "@/lib/knowledge";
import { buildSpecs, type CompiledSpecs } from "./compiler";
import {
  type AnswerAnalysis,
  type ClaimAssessment,
  type EvidenceUpdate,
  type InterviewAction,
  type RuntimeState,
  closingAction,
  deterministicFallback,
  initRuntimeState,
  renderRules,
  selectAction,
  surfaceForPhase,
  validateAnalysis,
  validateRendered,
} from "./runtime";

const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
const RUNTIME_MODEL = process.env.INTERVIEW_LLM_MODEL ?? process.env.LLM_MODEL ?? "openai/gpt-4.1-mini";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  stream?: boolean;
}

function computeRequestHash(token: string, messages: ChatMessage[]): string {
  const norm = JSON.stringify(
    messages.map((m) => ({
      role: m.role,
      content: m.content ?? "",
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    }))
  );
  return createHash("sha256").update(`${token}:${norm}`).digest("hex");
}

function buildSseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

async function callOpenRouter(messages: { role: string; content: string }[], responseFormatJson = false): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!key) {
    throw new Error("Missing OPENROUTER_API_KEY / LLM_API_KEY");
  }

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: RUNTIME_MODEL,
      messages,
      temperature: responseFormatJson ? 0 : 0.5,
      max_tokens: responseFormatJson ? 1400 : 500,
      ...(responseFormatJson ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function runAnalyzerLLM(
  learnerText: string,
  specs: CompiledSpecs,
  state: RuntimeState,
  knowledgeHits: any[]
): Promise<AnswerAnalysis> {
  const phase = specs.agent.phases[state.phase_index ?? 0] ?? null;
  const required = phase
    ? Object.fromEntries(
        phase.evidence_keys
          .filter((k) => k in specs.agent.required_evidence)
          .map((k) => [k, specs.agent.required_evidence[k]])
      )
    : specs.agent.required_evidence;

  const prompt = `Analyze only the learner's latest answer for the active interview phase.
Active phase: ${JSON.stringify(phase ? { name: phase.name, objective: phase.objective } : { objective: specs.agent.objective })}
Active evidence definitions: ${JSON.stringify(required)}
Active claim-handling policy: ${phase?.claim_handling ?? specs.agent.claim_handling}
Reference material from knowledge base: ${JSON.stringify(knowledgeHits.slice(0, 3))}

Learner's answer:
"${learnerText}"

Respond with a JSON object with this exact structure:
{
  "classification": "strong" | "partial" | "vague" | "unsupported" | "contradictory" | "unknown",
  "learner_intent": "answer" | "question" | "clarification" | "stop",
  "valid_evidence": ["quoted text from learner answer"],
  "evidence_updates": [
    {
      "key": "exact evidence key from active definitions",
      "status": "partial" | "sufficient",
      "evidence": "brief reasoning",
      "quote": "exact substring from learner answer",
      "provenance": "supported_elaboration" | "unverified_elaboration" | "hypothetical" | "observed_incident"
    }
  ],
  "claim_assessments": [],
  "unresolved_point": "what point or gap remains unresolved",
  "unresolved_evidence_key": "evidence key or null",
  "contradiction": null
}`;

  try {
    const rawJson = await callOpenRouter(
      [
        { role: "system", content: "You are an expert technical interviewer evaluator. Output strictly valid JSON." },
        { role: "user", content: prompt },
      ],
      true
    );

    const parsed = JSON.parse(rawJson) as AnswerAnalysis;
    const { applied } = validateAnalysis(parsed, specs.agent, state, learnerText);
    return applied;
  } catch {
    // Graceful fallback if model output is unparseable or API fails
    return {
      classification: "partial",
      learner_intent: "answer",
      valid_evidence: [],
      evidence_updates: [],
      claim_assessments: [],
      unresolved_point: "",
      unresolved_evidence_key: null,
    };
  }
}

async function renderPersonaSpeech(
  action: InterviewAction,
  specs: CompiledSpecs,
  state: RuntimeState
): Promise<string> {
  const rules = renderRules(specs.agent, state);
  const persona = specs.persona;
  const examples = persona.examples?.[action.name] ?? persona.examples?.general ?? [];

  const system = `You are ${persona.name}. You are conducting an interview.
Voice style: ${JSON.stringify(persona.style)}
Decision preferences: ${JSON.stringify(persona.decision_preferences)}
Evaluation principles: ${JSON.stringify(persona.calibration ?? {})}
Rules:
- Maximum words: ${rules.maximum_words}
- Maximum questions: ${rules.maximum_question_marks}
- Forbidden terms: ${JSON.stringify(rules.forbidden_terms ?? [])}
- Speak in first person as the interviewer. Never role reverse.
- Never use generic empty praise (like "that's solid" or "well reasoned").
- Never leak internal evidence keys.
- Do not repeat previous questions verbatim.
Reference persona examples:
${examples.slice(0, 3).map((ex) => `- "${ex}"`).join("\n")}`;

  const prompt = `Intent: ${action.intent}
Reason: ${action.reason}
Generate the next utterance in persona voice according to the intent and rules.`;

  try {
    const text = await callOpenRouter([
      { role: "system", content: system },
      { role: "user", content: prompt },
    ]);

    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    const errors = validateRendered(cleaned, action, specs.agent, state);
    if (errors.length === 0) {
      return cleaned;
    }
  } catch {
    // ignore and use deterministic fallback
  }

  return deterministicFallback(action, specs.agent, state);
}

export async function handleCompletions(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return Response.json(
      { error: { message: "Unauthorized: Missing runtime token", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  const session = await authorizeRuntimeSession(token);
  if (!session) {
    return Response.json(
      { error: { message: "Unauthorized: Invalid or expired session token", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  let body: ChatCompletionRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  const { model = "trainertwin-runtime", messages = [], stream = true, tools = [] } = body;
  const requestHash = computeRequestHash(token, messages);

  // Idempotency check: return cached completion without grading twice
  const lastComp = session.lastCompletion as { hash?: string; body?: unknown; sseChunks?: unknown[] } | null;
  if (lastComp && lastComp.hash === requestHash) {
    if (stream && Array.isArray(lastComp.sseChunks)) {
      return new Response(buildSseStream(lastComp.sseChunks), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Idempotent-Replay": "true",
        },
      });
    }
    return Response.json(lastComp.body, {
      headers: { "X-Idempotent-Replay": "true" },
    });
  }

  // Load and compile specs
  let configSnapshot = session.compiledSnapshot as Record<string, any> | null;
  if (!configSnapshot) {
    configSnapshot = await getAgentConfigForAgent(session.agentId, session.orgId, session.contextId ?? undefined);
    if (!configSnapshot) {
      return Response.json({ error: { message: "Session spec unavailable", type: "server_error" } }, { status: 500 });
    }
    await db.interviewSession.update({
      where: { id: session.id },
      data: { compiledSnapshot: configSnapshot },
    });
  }
  const specs = buildSpecs(configSnapshot);

  // Load or init state
  const state: RuntimeState = {
    ...initRuntimeState(),
    ...((session.runtimeState as Partial<RuntimeState> | null) ?? {}),
  };
  const advertisedToolNames = new Set(tools.map((t) => t.function.name));

  const timestamp = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${createHash("md5").update(requestHash).digest("hex").slice(0, 12)}`;

  let sseChunks: unknown[];
  let fullResponse: unknown;

  // Determine turn type
  const toolMessages = messages.filter((m) => m.role === "tool");
  const userMessages = messages.filter((m) => m.role === "user");
  const isToolResponseTurn = toolMessages.length > 0;
  const isOpeningTurn = state.learner_turns === 0 && (userMessages.length === 0 || userMessages[0].content?.toLowerCase().includes("start-interview") || userMessages[0].content?.toLowerCase().includes("session-start"));

  let turnUserText: string | null = null;
  let turnSpokenText: string | null = null;

  if (isOpeningTurn) {
    // Check if phase 0 requires a surface and we haven't emitted it yet
    const neededSurface = surfaceForPhase(specs.agent, 0);
    if (neededSurface && advertisedToolNames.has("surface") && state.current_surface !== neededSurface.action) {
      state.current_surface = neededSurface.action;
      state.actions.push("surface");

      sseChunks = [
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_surface_0",
                    type: "function",
                    function: {
                      name: "surface",
                      arguments: JSON.stringify(neededSurface),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];

      fullResponse = {
        id: completionId,
        object: "chat.completion",
        created: timestamp,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_surface_0",
                  type: "function",
                  function: {
                    name: "surface",
                    arguments: JSON.stringify(neededSurface),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
    } else {
      // Opening line
      const openingText = specs.agent.phases[0]?.opening || specs.agent.opening || "Welcome to the interview session. Let's begin.";
      state.actions.push("opening");
      turnSpokenText = openingText;

      sseChunks = [
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: openingText }, finish_reason: null }],
        },
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];

      fullResponse = {
        id: completionId,
        object: "chat.completion",
        created: timestamp,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: openingText }, finish_reason: "stop" }],
      };
    }
  } else if (isToolResponseTurn) {
    // Tool result reducer without re-grading
    let replyText = "Thank you. Let's proceed.";
    if (state.learner_turns === 0) {
      // Opening continuation after initial surface tool call
      replyText = specs.agent.phases[0]?.opening || specs.agent.opening || "Welcome to the interview session. Let's begin.";
      state.actions.push("opening");
    } else if (state.end_reason === "completed" || state.actions.includes("close_session")) {
      replyText = closingAction(state, specs.agent).fallback_text || "Thank you for the interview. We'll conclude here.";
    } else {
      replyText = `Received tool output. Let's continue with our discussion.`;
    }
    turnSpokenText = replyText;

    sseChunks = [
      {
        id: completionId,
        object: "chat.completion.chunk",
        created: timestamp,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null }],
      },
      {
        id: completionId,
        object: "chat.completion.chunk",
        created: timestamp,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];

    fullResponse = {
      id: completionId,
      object: "chat.completion",
      created: timestamp,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
    };
  } else {
    // User response turn
    const latestUserText = userMessages[userMessages.length - 1]?.content ?? "";
    turnUserText = String(latestUserText);
    state.learner_turns += 1;
    state.phase_turns += 1;

    // Fail-closed in-process knowledge retrieval
    let knowledgeHits: any[] = [];
    if (specs.knowledgeBases.length > 0) {
      try {
        knowledgeHits = await searchKnowledge(specs.knowledgeBases[0], String(latestUserText), 3, session.orgId);
      } catch {
        // fail-closed: persona voice degrades gracefully without crashing
        knowledgeHits = [];
      }
    }

    const analysis = await runAnalyzerLLM(String(latestUserText), specs, state, knowledgeHits);
    const action = selectAction(analysis, state, specs.persona, specs.agent);
    state.actions.push(action.name);

    if (action.close && advertisedToolNames.has("finish_session")) {
      // Emit finish_session tool call with null content
      state.end_reason = "completed";
      sseChunks = [
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_finish_session",
                    type: "function",
                    function: { name: "finish_session", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];

      fullResponse = {
        id: completionId,
        object: "chat.completion",
        created: timestamp,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_finish_session", type: "function", function: { name: "finish_session", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
    } else if (
      action.name === "transition_phase" &&
      advertisedToolNames.has("surface")
    ) {
      const neededSurface = surfaceForPhase(specs.agent, state.phase_index);
      if (neededSurface && state.current_surface !== neededSurface.action) {
        state.current_surface = neededSurface.action;
        state.actions.push("surface");

        sseChunks = [
          {
            id: completionId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_surface_${state.phase_index}`,
                      type: "function",
                      function: {
                        name: "surface",
                        arguments: JSON.stringify(neededSurface),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: completionId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
        ];

        fullResponse = {
          id: completionId,
          object: "chat.completion",
          created: timestamp,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_surface_${state.phase_index}`,
                    type: "function",
                    function: {
                      name: "surface",
                      arguments: JSON.stringify(neededSurface),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      } else {
        const spokenText = await renderPersonaSpeech(action, specs, state);
        turnSpokenText = spokenText;

        sseChunks = [
          {
            id: completionId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            choices: [{ index: 0, delta: { role: "assistant", content: spokenText }, finish_reason: null }],
          },
          {
            id: completionId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];

        fullResponse = {
          id: completionId,
          object: "chat.completion",
          created: timestamp,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: spokenText }, finish_reason: "stop" }],
        };
      }
    } else {
      // Render spoken trainer utterance
      const spokenText = await renderPersonaSpeech(action, specs, state);
      turnSpokenText = spokenText;

      sseChunks = [
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: spokenText }, finish_reason: null }],
        },
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];

      fullResponse = {
        id: completionId,
        object: "chat.completion",
        created: timestamp,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: spokenText }, finish_reason: "stop" }],
      };
    }
  }

  // Update transcript
  const currentTranscript: Array<{ role: "user" | "trainer"; text: string }> =
    Array.isArray(session.transcript)
      ? [...(session.transcript as Array<{ role: "user" | "trainer"; text: string }>)]
      : [];

  if (turnUserText) {
    currentTranscript.push({ role: "user", text: turnUserText });
  }
  if (turnSpokenText) {
    currentTranscript.push({ role: "trainer", text: turnSpokenText });
  }

  // Persist updated state, revision, evidence, transcript, and lastCompletion
  const newRevision = (session.runtimeRevision ?? 0) + 1;
  await db.interviewSession.update({
    where: { id: session.id },
    data: {
      runtimeState: JSON.parse(JSON.stringify(state)),
      runtimeRevision: newRevision,
      evidence: state.coverage,
      transcript: currentTranscript,
      lastCompletion: JSON.parse(
        JSON.stringify({
          hash: requestHash,
          body: fullResponse,
          sseChunks,
        })
      ),
    },
  });

  if (stream) {
    return new Response(buildSseStream(sseChunks), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Execution-Count": String(newRevision),
      },
    });
  }

  return Response.json(fullResponse, {
    headers: { "X-Execution-Count": String(newRevision) },
  });
}
