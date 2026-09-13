/**
 * Variant 6: Autonomous Tool-Calling Agent Handler
 *
 * CONCEPT:
 * Replaces the rigid multi-stage injection pipeline (knowledge -> direction -> analysis -> content -> style_gate -> renderer)
 * with an autonomous conversational agent equipped with tools:
 * 1. search_knowledge: ChromaDB domain references
 * 2. search_style: Vasanth style episodes
 * 3. search_candidate_resume: In-memory document chunk search
 *
 * The agent receives the scenario spec, active phase, and candidate transcript.
 * It autonomously decides whether to call tools (when facts/phrasing are needed)
 * or respond directly in a single conversational turn.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { getAgentConfigForAgent } from "@/lib/specs";
import { MainCollectionService } from "@/lib/main-collection";
import { env } from "@/env";
import { buildSpecs, type CompiledSpecs } from "@/lib/runtime/compiler";
import { searchDocumentChunks } from "@/lib/context-document-service";
import {
  type InterviewAction,
  type RuntimeState,
  deterministicFallback,
  extractLearnerName,
  initRuntimeState,
  recordAskedQuestion,
  refreshCurrentTopic,
  surfaceForPhase,
  wordCount,
} from "@/lib/runtime/runtime";

const OPENROUTER_BASE_URL = env.OPENROUTER_BASE_URL.replace(/\/$/, "");
const getRuntimeModel = () => process.env.INTERVIEW_LLM_MODEL ?? env.INTERVIEW_LLM_MODEL;

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface UsageSink {
  stages: Array<{ stage: string; ms: number; promptTokens?: number; completionTokens?: number }>;
  add(stage: string, ms: number, usage: Partial<CompletionUsage> | null | undefined): void;
  totals(): CompletionUsage;
}

function createUsageSink(): UsageSink {
  const totals: CompletionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    stages: [],
    add(stage, ms, usage) {
      const prompt = usage?.prompt_tokens ?? 0;
      const completion = usage?.completion_tokens ?? 0;
      totals.prompt_tokens += prompt;
      totals.completion_tokens += completion;
      totals.total_tokens += usage?.total_tokens ?? prompt + completion;
      this.stages.push({ stage, ms, promptTokens: prompt || undefined, completionTokens: completion || undefined });
    },
    totals: () => ({ ...totals }),
  };
}

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
  messages?: ChatMessage[];
  stream?: boolean;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
}

export type TranscriptTurn = {
  role: "trainer" | "user";
  text: string;
};

function computeRequestHash(prefix: string, messages: unknown[]): string {
  return createHash("sha256")
    .update(prefix + JSON.stringify(messages))
    .digest("hex");
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

function transcriptText(transcript: TranscriptTurn[]): string {
  if (!transcript.length) return "No conversation history yet.";
  return transcript
    .map((turn) => `${turn.role === "trainer" ? "Interviewer (Vasanth)" : "Candidate"}: ${turn.text}`)
    .join("\n");
}

function clip(text: string, maxChars: number): string {
  const s = text.trim();
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`;
}

function formatSessionFacts(specs: CompiledSpecs): string {
  const parts: string[] = [];
  if (specs.contextDocument) {
    parts.push(`Uploaded Document Context (${specs.contextDocument.name}):\n${clip(specs.contextDocument.content, 3500)}`);
  }
  return parts.join("\n\n");
}

function isRepeatRequest(text: string): boolean {
  return /^(can you repeat|could you repeat|repeat the question|sorry\??|what was the question|pardon|say that again)\b/i.test(text.trim());
}

// Tool definitions for OpenRouter
const AUTONOMOUS_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_knowledge",
      description: "Query technical domain knowledge references from ChromaDB when you need technical concepts, design patterns, or reference architectures.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Technical concept or topic to look up" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_style",
      description: "Search past Vasanth speaking style examples to see how Vasanth phrases questions or acknowledges answers in similar situations.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The conversational function or situation (e.g. 'probing on kafka error handling', 'acknowledging metrics')" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_candidate_resume",
      description: "Search the candidate's resume and attached documents for specific facts, claims, metrics, or technologies.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords or claim to look up in the candidate resume" },
        },
        required: ["query"],
      },
    },
  },
];

async function callOpenRouterToolAgent(
  stage: string,
  messages: ChatMessage[],
  tools: typeof AUTONOMOUS_TOOLS,
  usage?: UsageSink
): Promise<{ message: ChatMessage; usage: CompletionUsage | null }> {
  const model = getRuntimeModel();
  const started = performance.now();
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
      "X-Title": "TrainerTwin Studio (Autonomous Agent Experiment)",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 600,
    }),
  });

  const durationMs = Math.round(performance.now() - started);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter tool agent failed [${response.status}]: ${errorText}`);
  }

  const data = (await response.json()) as any;
  const choice = data.choices?.[0]?.message;
  const callUsage = data.usage as CompletionUsage | undefined;
  if (usage && callUsage) {
    usage.add(stage, durationMs, callUsage);
  }

  return {
    message: choice ?? { role: "assistant", content: "" },
    usage: callUsage ?? null,
  };
}

async function executeAutonomousTurn(
  specs: CompiledSpecs,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  latestUserText: string,
  orgId: string,
  usage?: UsageSink
): Promise<{ text: string; toolsCalled: string[]; meta: { attempts: number; toolCallsCount: number } }> {
  const persona = specs.persona;
  const phase = specs.agent.phases[state.phase_index] ?? null;
  const candidateName = state.learner_name || "the candidate";

  // Pre-load document chunks for resume search tool
  const documentChunksPromise = db.contextDocumentChunk.findMany({
    where: { document: { orgId } },
    orderBy: { chunkIndex: "asc" },
  });

  const systemPrompt = `You are ${persona.name}, the lead technical interviewer conversation controller and single-pass styled trainer conducting a live voice interview.

SESSION SPEC:
Scenario: ${specs.agent.name ?? "Technical Interview"}
Objective: ${specs.agent.objective}
Active Phase: ${JSON.stringify(phase ? { name: phase.name, objective: phase.objective } : null)}
Domain Principles: ${JSON.stringify(specs.domain.principles ?? [])}
Candidate Name: ${candidateName}
${formatSessionFacts(specs)}

AUTONOMOUS VOICE INTERVIEWER RULES:
- You are in a LIVE, fast-paced voice interview.
- You have tools available to search technical domain knowledge ('search_knowledge'), look up candidate resume facts ('search_candidate_resume'), or check your past phrasing style ('search_style').
- Call tools ONLY when you genuinely need to look up external facts or technical references to formulate your probe.
- If you already have sufficient context to converse naturally and probe the candidate's latest response, DO NOT call tools. Respond directly.
- SPRINT VOICE STYLE:
  * Acknowledge what the candidate just said with natural Vasanth cadence ("Yeah", "Right", "Got it", "Okay, Harini").
  * Probe the concrete technical mechanism, architecture, or design decision behind their claim.
  * Ask exactly ONE focused question. Never ask compound or multiple questions.
  * Keep your response under 45 words so it is easy to listen to.
  * Do NOT output markdown, bullet points, asterisks, or quotes.`;

  const agentMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Conversation History:\n${transcriptText(transcript)}\n\nCandidate just said: "${latestUserText}"\n${state.pending_question ? `Previous question asked: "${state.pending_question}"` : ""}\n\nRespond now as Vasanth. Use tools only if needed, otherwise speak your response directly.`,
    },
  ];

  const toolsCalled: string[] = [];
  let round = 0;
  const maxRounds = 3;

  while (round < maxRounds) {
    round++;
    const { message } = await callOpenRouterToolAgent(
      round === 1 ? "direct_styled_speech" : "direct_styled_speech",
      agentMessages,
      AUTONOMOUS_TOOLS,
      usage
    );

    // If model made tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      agentMessages.push(message);

      for (const call of message.tool_calls) {
        const fnName = call.function.name;
        toolsCalled.push(fnName);
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments);
        } catch {}

        let toolResultStr = "No results found.";

        if (fnName === "search_knowledge") {
          try {
            const hits = await MainCollectionService.searchKnowledge(orgId, parsedArgs.query ?? latestUserText, { limit: 3 });
            if (hits.length) {
              toolResultStr = hits.map((h: any) => h.text).join("\n---\n").slice(0, 1500);
            }
          } catch (err) {
            toolResultStr = `Error searching knowledge: ${String(err)}`;
          }
        } else if (fnName === "search_style") {
          try {
            const hits = await MainCollectionService.searchStyleEpisodes(orgId, parsedArgs.query ?? latestUserText, {
              personaId: specs.persona.id,
              limit: 3,
            });
            if (hits.length) {
              toolResultStr = hits.map((h: any) => h.text).join("\n---\n").slice(0, 1500);
            }
          } catch (err) {
            toolResultStr = `Error searching style: ${String(err)}`;
          }
        } else if (fnName === "search_candidate_resume") {
          try {
            if (specs.contextDocument?.content) {
              const content = specs.contextDocument.content;
              const paragraphs = content.split(/\n\n+/);
              const query = (parsedArgs.query ?? latestUserText).toLowerCase();
              const hits = paragraphs.filter((p) => p.toLowerCase().includes(query));
              toolResultStr = hits.length
                ? hits.slice(0, 3).join("\n---\n").slice(0, 1500)
                : `No specific mention of "${parsedArgs.query}" found in candidate resume.`;
            } else {
              const chunks = await documentChunksPromise;
              const hits = searchDocumentChunks(chunks, parsedArgs.query ?? latestUserText, 3);
              toolResultStr = hits.length
                ? hits.map((h) => `${h.heading ? `${h.heading}: ` : ""}${h.text}`).join("\n---\n").slice(0, 1500)
                : "No resume details found.";
            }
          } catch (err) {
            toolResultStr = `Error searching resume: ${String(err)}`;
          }
        }

        agentMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResultStr,
        });
      }
      // Continue to next round so the model generates response using tool results
      continue;
    }

    // Direct text response
    if (message.content) {
      const cleanText = message.content.trim().replace(/^["']|["']$/g, "");
      return {
        text: cleanText,
        toolsCalled,
        meta: { attempts: round, toolCallsCount: toolsCalled.length },
      };
    }
  }

  return {
    text: "Right, got it. Can you walk me through the key technical decision you made there?",
    toolsCalled,
    meta: { attempts: round, toolCallsCount: toolsCalled.length },
  };
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

  try {
    return await runAutonomousCompletion(session, body);
  } catch (error) {
    console.error("[interview-runtime] completion failed", error);
    return Response.json(
      {
        error: {
          message: "The interview runtime failed to process this completion.",
          type: "server_error",
          code: "internal_error",
        },
      },
      { status: 500 }
    );
  }
}

async function runAutonomousCompletion(
  session: NonNullable<Awaited<ReturnType<typeof authorizeRuntimeSession>>>,
  body: ChatCompletionRequest
): Promise<Response> {
  const { messages = [], stream = true, tools = [] } = body;
  const model = "trainertwin-runtime";
  const requestHash = computeRequestHash(session.runtimeTokenHash + session.id, messages);

  // Idempotency check
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

  let configSnapshot = session.compiledSnapshot as Parameters<typeof buildSpecs>[0] | null;
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
  const state: RuntimeState = {
    ...initRuntimeState(),
    ...((session.runtimeState as Partial<RuntimeState> | null) ?? {}),
  };
  const currentTranscript: TranscriptTurn[] = Array.isArray(session.transcript)
    ? [...(session.transcript as TranscriptTurn[])]
    : [];
  const advertisedToolNames = new Set(tools.map((t) => t.function.name));

  const timestamp = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${createHash("md5").update(requestHash).digest("hex").slice(0, 12)}`;

  let sseChunks: unknown[];
  let fullResponse: unknown;

  const startedAt = performance.now();
  const usageSink = createUsageSink();
  const userMessages = messages.filter((m) => m.role === "user");
  const lastMessage = messages[messages.length - 1];
  const isToolResponseTurn = lastMessage?.role === "tool";
  const isOpeningTurn =
    state.learner_turns === 0 &&
    !state.actions.includes("opening") &&
    lastMessage?.role !== "user" &&
    !isToolResponseTurn;

  let turnUserText: string | null = null;
  let turnSpokenText: string | null = null;

  if (isOpeningTurn) {
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
                    function: { name: "surface", arguments: JSON.stringify(neededSurface) },
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
                  function: { name: "surface", arguments: JSON.stringify(neededSurface) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
    } else {
      const openingAction = {
        name: "opening",
        intent: specs.agent.opening ?? "Welcome the learner and begin the discussion.",
        evidence_key: "",
        close: false,
        expects_answer: true,
      } as InterviewAction;

      const openingText = specs.agent.opening
        ? specs.agent.opening
        : `Hi, I'm Vasanth. Thanks for joining today. Let's dive into your recent project experience. Could you give me an overview of what you built and your role?`;

      state.actions.push("opening");
      recordAskedQuestion(state, openingAction, openingText);
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
    const rawToolCallId = lastMessage.tool_call_id ?? "";
    const surfaceMatch = rawToolCallId.match(/^call_surface_(\d+)$/);

    let replyText: string;
    if (surfaceMatch) {
      const phaseIndex = parseInt(surfaceMatch[1], 10);
      const targetPhase = specs.agent.phases[phaseIndex];
      replyText = targetPhase?.opening
        ? targetPhase.opening
        : `Let's move on to ${targetPhase?.name ?? "the next section"}.`;
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
    const latestUserText = (userMessages[userMessages.length - 1]?.content ?? "").trim();
    turnUserText = latestUserText;

    if (!state.learner_name) {
      state.learner_name = extractLearnerName(latestUserText);
    }

    // Fast-path repeat request check
    if (isRepeatRequest(latestUserText) && state.pending_question) {
      const repeatReply = `No problem. I was asking: ${state.pending_question}`;
      turnSpokenText = repeatReply;

      sseChunks = [
        {
          id: completionId,
          object: "chat.completion.chunk",
          created: timestamp,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: repeatReply }, finish_reason: null }],
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
        choices: [{ index: 0, message: { role: "assistant", content: repeatReply }, finish_reason: "stop" }],
      };
    } else {
      // Autonomous agent execution
      const agentResult = await executeAutonomousTurn(
        specs,
        state,
        currentTranscript,
        latestUserText,
        session.orgId,
        usageSink
      );

      const spokenText = agentResult.text;
      turnSpokenText = spokenText;

      const dummyAction: InterviewAction = {
        name: "probe",
        intent: "Probe candidate on design details.",
        evidence_key: "technical_architecture",
        close: false,
        expects_answer: true,
      };

      state.learner_turns += 1;
      state.actions.push(dummyAction.name);
      recordAskedQuestion(state, dummyAction, spokenText, true);
      refreshCurrentTopic(state, spokenText, latestUserText);

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

  // Append usage chunk
  const usageTotals = usageSink.totals();
  sseChunks.push({
    id: completionId,
    object: "chat.completion.chunk",
    created: timestamp,
    model,
    choices: [],
    usage: usageTotals,
  });
  (fullResponse as Record<string, unknown>).usage = usageTotals;

  console.info("[interview-runtime] completion served", {
    sessionId: session.id,
    revision: (session.runtimeRevision ?? 0) + 1,
    turn: isOpeningTurn ? "opening" : isToolResponseTurn ? "tool_result" : "learner",
    latencyMs: Math.round(performance.now() - startedAt),
    promptTokens: usageTotals.prompt_tokens,
    completionTokens: usageTotals.completion_tokens,
    totalTokens: usageTotals.total_tokens,
    stages: usageSink.stages.map((s) => `${s.stage}:${s.ms}ms`),
  });

  // Non-blocking async DB persist
  if (turnUserText) {
    currentTranscript.push({ role: "user", text: turnUserText });
  }
  if (turnSpokenText) {
    currentTranscript.push({ role: "trainer", text: turnSpokenText });
  }

  const newRevision = (session.runtimeRevision ?? 0) + 1;
  const updatePromise = db.interviewSession.update({
    where: { id: session.id },
    data: {
      runtimeRevision: newRevision,
      runtimeState: state as any,
      transcript: currentTranscript as any,
      lastCompletion: JSON.parse(
        JSON.stringify({
          hash: requestHash,
          body: fullResponse,
          sseChunks,
        })
      ),
    },
  });

  if (process.env.BENCH_BLOCKING_PERSIST === "1") {
    await updatePromise;
  } else {
    updatePromise.catch((err) => console.error("[interview-runtime] async persist error:", err));
  }

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
