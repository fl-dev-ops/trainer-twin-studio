import { timingSafeEqual } from "node:crypto";
import { defineChannel, POST, type Session } from "eve/channels";
import { studioPrincipal } from "../lib/auth";
import { createQuestionBridge } from "../lib/question-bridge";
import { followUpGradesFor } from "../lib/turn-grades";
import { summarizeToolInput, summarizeToolOutput } from "../lib/tool-trace";
import { thinkingBudgetSchema } from "../lib/thinking-budget";

/** Resume claims already highlighted per session, so the bridge never speaks a spent claim's question. */
// ponytail: unbounded Map, one small Set per voice session; a process restart clears it.
const usedClaimsBySession = new Map<string, Set<string>>();
function usedClaimsFor(sessionId: string) {
  let used = usedClaimsBySession.get(sessionId);
  if (!used) {
    used = new Set();
    usedClaimsBySession.set(sessionId, used);
  }
  return used;
}
/**
 * OpenAI-compatible chat completions bridge. This endpoint allows LiveKit
 * (or any standard OpenAI client) to use the Eve agent as the conversational brain.
 *
 * - LiveKit acts purely as transport: STT/TTS + room RPC tool execution.
 * - Eve owns persona fidelity, scenario grounding, move decisions, and retrieval.
 * - Streams standard SSE `chat.completion.chunk` events (content deltas, tool_calls, usage).
 * - On HTTP abort (learner barge-in), triggers cooperative session cancellation.
 */

const USER_INACTIVE_SIGNAL = "__TRAINERTWIN_USER_INACTIVE__";

/** Pure side-effect tools that do not require conversational follow-up speech. */
const PURE_SIDE_EFFECT_TOOLS = new Set([
  "surface",
  "finish_session",
  "clear_canvas",
  "highlight_code",
  "highlight_whiteboard",
  "highlight_canvas_element",
]);

type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_call_id?: string;
  name?: string;
};

type ToolDeclaration = {
  type?: string;
  name?: string;
  function?: { name?: string };
};

type ChatCompletionBody = {
  messages?: ChatMessage[];
  stream?: boolean;
  model?: string;
  tools?: ToolDeclaration[];
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

function isPureSideEffectToolResult(message: ChatMessage | undefined): boolean {
  if (!message || message.role !== "tool") return false;
  if (message.name && PURE_SIDE_EFFECT_TOOLS.has(message.name)) return true;
  const text = contentToText(message.content);
  // Match {"status": "ok"...}, {'status': 'ok'...}, {"status":"completed"}, etc.
  if (/['"]status['"]\s*:\s*['"](ok|completed)['"]/i.test(text) || /['"]ok['"]\s*:\s*true/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Maps incoming chat-completions messages to ONE Eve turn input: only the
 * latest relevant message matters because the Eve session maintains the
 * durable history.
 */
function mapLatestMessage(messages: ChatMessage[]): string | null {
  // LiveKit's generate_reply(instructions="session-start") arrives as a SYSTEM
  // instructions message in chat ctx (not a user turn), so "session-start" is
  // matched on content regardless of role. The last relevant message wins.
  let latestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate.role === "user" ||
      candidate.role === "tool" ||
      contentToText(candidate.content).trim() === "session-start" ||
      contentToText(candidate.content).trim() === USER_INACTIVE_SIGNAL
    ) {
      latestIndex = index;
      break;
    }
  }
  const latest = messages[latestIndex];
  if (!latest) return null;
  if (latest.role === "tool") {
    return `[TOOL RESULT] ${latest.tool_call_id ?? ""} ${latest.name ?? ""}\n${contentToText(latest.content)}`;
  }
  const text = contentToText(latest.content).trim();
  if (!text) return null;
  // LiveKit transport control messages become explicit internal events for Eve.
  if (text === "session-start") return "[OPENING] Generate the session opening.";
  if (text === USER_INACTIVE_SIGNAL) {
    return "[USER INACTIVE] The learner has been silent for 60 seconds. Adapt to the current moment in the session. Do not advance the interview or ask a new interview question.";
  }

  let previousTurnIndex = -1;
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" || messages[index].role === "tool") {
      previousTurnIndex = index;
      break;
    }
  }
  const observerNotes = messages
    .slice(previousTurnIndex + 1, latestIndex)
    .filter((message) => message.role === "developer")
    .map((message) => contentToText(message.content).trim())
    .filter((note) => note.startsWith("[SCREEN OBSERVER NOTE]"));
  if (!observerNotes.length) return text;
  return `[SCREEN OBSERVER CONTEXT]\n${observerNotes.join("\n")}\n[CANDIDATE]\n${text}`;
}

type StreamEvent = {
  type: string;
  data: Record<string, unknown> & {
    messageDelta?: string;
    actions?: { kind: string; callId: string; toolName: string; input: unknown }[];
    result?: {
      kind?: string;
      callId?: string;
      toolName?: string;
      isError?: boolean;
      output?: unknown;
    };
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  };
};

function serviceAuthorized(request: Request) {
  const expected = process.env.COPILOT_SERVICE_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export default defineChannel({
  routes: [
    POST("/internal/sessions", async (request, { resolveSession }) => {
      if (!serviceAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
      const body = await request.json().catch(() => null) as { sessionId?: unknown; mode?: unknown } | null;
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      if (!orgId || !sessionId || !["chat", "voice"].includes(String(body?.mode))) {
        return Response.json({ error: "orgId, sessionId, and mode are required" }, { status: 400 });
      }
      return Response.json({ ready: true, sessionId, existing: Boolean(await resolveSession(sessionId)) });
    }),
    POST("/v1/chat/completions", async (request, { from, resolveSession }) => {
      const principal = studioPrincipal(request);
      const orgHeader = request.headers.get("x-trainertwin-org-id")?.trim();
      const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();

      const orgId = principal?.principalId ?? orgHeader;
      if (!orgId) {
        return Response.json({ error: "Organization is required" }, { status: 401 });
      }

      const thinkingBudgetHeader = request.headers.get("x-thinking-budget")?.trim();
      if (thinkingBudgetHeader !== undefined && !thinkingBudgetSchema.safeParse(thinkingBudgetHeader).success) {
        return Response.json({ error: "x-thinking-budget must be -1 or a non-negative safe integer" }, { status: 400 });
      }

      const body = (await request.json().catch(() => null)) as ChatCompletionBody | null;
      const latestRaw = [...(body?.messages ?? [])].reverse().find(
        (m) => m.role === "user" || m.role === "tool" || contentToText(m.content).trim() === "session-start"
      );

      // "trainertwin-brain" / "trainertwin-runtime" are magic model names meaning
      // "use the Eve agent's own default model" — anything else is a model override.
      const MAGIC_MODELS = new Set(["trainertwin-brain", "trainertwin-runtime"]);
      const requestedModel =
        request.headers.get("x-trainertwin-model")?.trim() ||
        (body?.model && !MAGIC_MODELS.has(body.model) ? body.model : undefined);

      // If this is a tool execution result for a pure side-effect tool (e.g. surface open_pdf,
      // highlight_whiteboard), complete immediately without invoking the model to speak more.
      if (isPureSideEffectToolResult(latestRaw)) {
        const completionId = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        const model = requestedModel ?? body?.model ?? "trainertwin-runtime";
        const encoder = new TextEncoder();
        const chunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "close",
          },
        });
      }

      const message = mapLatestMessage(body?.messages ?? []);
      // One line per transport request (before any early return) so dropped/rejected turns are visible.
      console.info("[openai-compat] request " + JSON.stringify({
        sessionId: request.headers.get("x-trainertwin-session-id")?.trim() ?? null,
        at_ms: Date.now(),
        roles: (body?.messages ?? []).map((m) => m.role),
        accepted: Boolean(message),
      }));
      if (!message) return Response.json({ error: "No user or tool message to process" }, { status: 400 });

      // Determine advertised tools from client request
      const advertisedTools = new Set<string>();
      if (Array.isArray(body?.tools)) {
        for (const t of body.tools) {
          const name = t.function?.name ?? t.name;
          if (name) advertisedTools.add(name);
        }
      }

      // Address = durable conversation cursor
      const sessionIdHeader = request.headers.get("x-trainertwin-session-id")?.trim();
      const address = sessionIdHeader || (bearer ? `token:${bearer}` : `sess:${crypto.randomUUID()}`);
      const sessionId = sessionIdHeader || (bearer ? bearer : address);

      const modeHeader = request.headers.get("x-trainertwin-mode")?.trim();
      const mode = modeHeader === "chat" ? "chat" : "voice";

      const attributes: Record<string, string> = {
        orgId,
        sessionId,
        mode,
        clientTools: [...advertisedTools].sort().join(","),
        ...(requestedModel ? { model: requestedModel } : {}),
      };
      const agentSlug = request.headers.get("x-trainertwin-agent-slug")?.trim();
      const personaSlug = request.headers.get("x-trainertwin-persona-slug")?.trim();
      if (agentSlug) attributes.agentSlug = agentSlug;
      if (personaSlug) attributes.personaSlug = personaSlug;

      const asymmetricHeader = request.headers.get("x-asymmetric-thinking")?.trim();
      if (thinkingBudgetHeader !== undefined) attributes.thinkingBudget = thinkingBudgetHeader;
      if (asymmetricHeader) attributes.asymmetricThinking = asymmetricHeader;

      const auth = {
        attributes,
        authenticator: principal?.authenticator ?? "openai-compat",
        principalId: orgId,
        principalType: "organization",
      };

      const inputKind = message.startsWith("[OPENING]")
        ? "opening"
        : message.startsWith("[TOOL RESULT]")
          ? "tool_result"
          : message.startsWith("[USER INACTIVE]")
            ? "inactivity_nudge"
            : "learner";
      const t_start = Date.now();
      const source = from(address);
      const existing = await resolveSession(address);
      const t_resolved = Date.now();
      const tailIndex = existing ? await existing.getStreamTailIndex() : 0;
      const t_tail = Date.now();
      let session: Session;
      try {
        session = await source.send(message, { auth, turnPolicy: "steer" });
      } catch (sendErr) {
        console.error("[EVE SEND ERROR]", sendErr);
        return Response.json({ error: String(sendErr) }, { status: 400 });
      }
      const t_sent = Date.now();

      // Hook up client abort to cooperative turn cancellation (barge-in support)
      request.signal.addEventListener("abort", () => {
        void session.cancel().catch(() => {});
      });

      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = requestedModel ?? body?.model ?? "trainertwin-brain";

      const stream = await session.getEventStream(tailIndex === undefined ? {} : { startIndex: tailIndex });
      const t_stream = Date.now();
      const reader = stream.getReader();

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const writeChunk = (payload: unknown) => writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

      void (async () => {
        let sawActivity = false;
        let sawTurnStarted = false;
        let ttftMs: number | null = null;
        let tFirstEvent = 0;
        let tPass1Decision: number | null = null;
        let tFirstTextDelta: number | null = null;
        let stepCount = 0;
        let currentStepStart: number | null = null;
        // decision_ms = LLM-only time until it requested tools; tools_ms = remainder of the step
        // (Eve runs the requested tools inside the same step before step.completed).
        const llmSteps: Array<{
          stepIndex: number;
          start_ms: number;
          end_ms?: number;
          duration_ms?: number;
          ttft_ms?: number;
          decision_ms?: number;
          tools_ms?: number;
          tools?: string[];
          input_tokens?: number;
          output_tokens?: number;
          cached_input_tokens?: number;
          spoke?: boolean;
        }> = [];
        const totals = { inputTokens: 0, outputTokens: 0 };
        const questionBridge = createQuestionBridge(mode, usedClaimsFor(sessionId), () => followUpGradesFor(sessionId));
        const markSpoken = () => {
          if (ttftMs === null) {
            ttftMs = Date.now() - t_start;
            tFirstTextDelta = Date.now();
          }
          const currentStep = currentStepStart !== null ? llmSteps[llmSteps.length - 1] : undefined;
          if (currentStep && currentStep.ttft_ms === undefined) currentStep.ttft_ms = Date.now() - currentStepStart!;
          if (currentStep) currentStep.spoke = true;
        };
        const writeText = (content: string) => writeChunk({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        });
        let usage: { inputTokens?: number; outputTokens?: number } | null = null;
        const allToolsCalled: { name: string; callId: string; input: unknown }[] = [];
        const toolExecutionTimes: Record<string, { start: number; end?: number; duration_ms?: number }> = {};
        const executedToolTimings: {
          name: string;
          callId: string;
          duration_ms: number;
          step?: number;
          input?: Record<string, unknown>;
          output?: Record<string, unknown>;
        }[] = [];
        const retrievalTraces: { callId: string; input: unknown; output: unknown }[] = [];
        const finishReason = () => "stop";

        try {
          while (true) {
            const { done, value: event } = await reader.read();
            if (done) break;
            const ev = event as StreamEvent;
            if (!tFirstEvent) tFirstEvent = Date.now() - t_start;

            if (ev.type === "turn.started") {
              sawTurnStarted = true;
            }

            if (ev.type === "step.started") {
              stepCount += 1;
              currentStepStart = Date.now();
              llmSteps.push({
                stepIndex: stepCount,
                start_ms: currentStepStart - t_start,
              });
            }

            // Text deltas
            if (ev.type === "message.appended" && typeof ev.data.messageDelta === "string") {
              sawActivity = true;
              const content = questionBridge.onModelText(ev.data.messageDelta);
              if (content === null) continue;
              markSpoken();
              await writeText(content);
              continue;
            }

            if (ev.type === "actions.requested" && Array.isArray(ev.data.actions)) {
              if (tPass1Decision === null) {
                tPass1Decision = Date.now();
              }
              const requestingStep = currentStepStart !== null ? llmSteps[llmSteps.length - 1] : undefined;
              if (requestingStep && requestingStep.decision_ms === undefined) {
                requestingStep.decision_ms = Date.now() - currentStepStart!;
              }
              for (const action of ev.data.actions) {
                if (requestingStep && action.kind === "tool-call") (requestingStep.tools ??= []).push(action.toolName);
                if (action.kind === "tool-call") {
                  allToolsCalled.push({ name: action.toolName, callId: action.callId, input: action.input });
                  toolExecutionTimes[action.callId] = { start: Date.now() };
                }
              }
              const bridged = questionBridge.onToolCalls(ev.data.actions);
              if (bridged) {
                sawActivity = true;
                markSpoken();
                await writeText(bridged);
              }
              continue;
            }

            if (ev.type === "action.result") {
              const result = ev.data.result;
              if (result) questionBridge.onToolResult(result);
              if (result?.kind === "tool-result") {
                const callId = result.callId ?? "";
                const timing = toolExecutionTimes[callId];
                if (timing) {
                  timing.end = Date.now();
                  timing.duration_ms = timing.end - timing.start;
                  const toolName = result.toolName ?? "unknown";
                  const requested = allToolsCalled.find((call) => call.callId === callId);
                  executedToolTimings.push({
                    name: toolName,
                    callId,
                    duration_ms: timing.duration_ms,
                    step: llmSteps.length,
                    input: summarizeToolInput(toolName, requested?.input),
                    output: summarizeToolOutput(toolName, result.output, result.isError),
                  });
                }
                if (result.toolName === "search_knowledge" && !result.isError) {
                  retrievalTraces.push({
                    callId: result.callId ?? "",
                    input: allToolsCalled.find((call) => call.callId === result.callId)?.input ?? {},
                    output: result.output,
                  });
                }
              }
              continue;
            }

            if (ev.type === "step.completed") {
              if (currentStepStart !== null) {
                const currentStep = llmSteps[llmSteps.length - 1];
                if (currentStep) {
                  currentStep.end_ms = Date.now() - t_start;
                  currentStep.duration_ms = Date.now() - currentStepStart;
                  if (currentStep.decision_ms !== undefined) {
                    currentStep.tools_ms = currentStep.duration_ms - currentStep.decision_ms;
                  }
                  if (ev.data.usage) {
                    currentStep.input_tokens = ev.data.usage.inputTokens ?? 0;
                    currentStep.output_tokens = ev.data.usage.outputTokens ?? 0;
                    currentStep.cached_input_tokens = ev.data.usage.cacheReadTokens ?? 0;
                  }
                }
                currentStepStart = null;
              }
              if (ev.data.usage) {
                usage = ev.data.usage;
                totals.inputTokens += ev.data.usage.inputTokens ?? 0;
                totals.outputTokens += ev.data.usage.outputTokens ?? 0;
              }
              continue;
            }

            const terminal =
              (sawTurnStarted && ev.type === "session.waiting") ||
              ev.type === "turn.cancelled" ||
              ev.type === "session.failed" ||
              ev.type === "session.completed";

            if (terminal && (sawActivity || sawTurnStarted)) {
              const wallMs = Date.now() - t_start;
              const lastToolEndMs = executedToolTimings.length > 0
                ? Math.max(...executedToolTimings.map((t) => toolExecutionTimes[t.callId]?.end ?? t_start))
                : null;
              const pass2AnswerTtftMs = (lastToolEndMs !== null && tFirstTextDelta !== null)
                ? Math.max(0, tFirstTextDelta - lastToolEndMs)
                : null;

              const call1Duration = llmSteps[0]?.duration_ms ?? (tPass1Decision ? tPass1Decision - t_start : null);
              const call2Ttft = llmSteps[1]?.ttft_ms ?? pass2AnswerTtftMs;

              const brainTrace = {
                sessionId,
                mode,
                model,
                // Mirrors agent.ts model resolution: the model Eve actually ran, not the request label.
                llm_model: requestedModel || process.env.CHAT_AGENT_MODEL || "google/gemini-3.5-flash-lite",
                llm_route: process.env.GEMINI_GATEWAY_PROVIDER?.trim() || "google",
                ...questionBridge.trace(t_start),
                started_at_ms: t_start,
                status: ev.type,
                input_kind: inputKind,
                eve_overhead_ms: {
                  resolve_session: t_resolved - t_start,
                  get_tail: t_tail - t_resolved,
                  session_send: t_sent - t_tail,
                  stream_attach: t_stream - t_sent,
                  first_event: tFirstEvent,
                },
                total_turn_ms: wallMs,
                first_token_ttft_ms: ttftMs,
                call1_tool_decision_ms: call1Duration,
                tools_executed: executedToolTimings,
                call2_answer_ttft_ms: call2Ttft,
                llm_steps: llmSteps,
                prompt_tokens: totals.inputTokens,
                completion_tokens: totals.outputTokens,
              };

              console.info("[brain-trace] " + JSON.stringify(brainTrace));

              console.info("[openai-compat] turn timing", {
                sessionId,
                mode,
                resolve_session_ms: t_resolved - t_start,
                get_tail_ms: t_tail - t_resolved,
                session_send_ms: t_sent - t_tail,
                stream_attach_ms: t_stream - t_sent,
                first_event_ms: tFirstEvent,
                first_token_ms: ttftMs,
                total_turn_ms: wallMs,
              });
              await writeChunk({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason() }],
                tools_called: allToolsCalled,
                retrieval_traces: retrievalTraces,
                ttft_ms: ttftMs ?? wallMs,
                wall_ms: wallMs,
                brain_trace: brainTrace,
                timing_breakdown: {
                  resolve_session_ms: t_resolved - t_start,
                  get_tail_ms: t_tail - t_resolved,
                  session_send_ms: t_sent - t_tail,
                  stream_attach_ms: t_stream - t_sent,
                  first_event_ms: tFirstEvent,
                  first_token_ms: ttftMs,
                  total_turn_ms: wallMs,
                },
                ...(usage
                  ? {
                      usage: {
                        prompt_tokens: usage.inputTokens ?? 0,
                        completion_tokens: usage.outputTokens ?? 0,
                        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
                      },
                    }
                  : {}),
              });
              break;
            }
          }
        } catch {
          // Stream errors fall through to finally
        } finally {
          await writer.write(encoder.encode("data: [DONE]\n\n")).catch(() => {});
          await writer.close().catch(() => {});
          await reader.cancel().catch(() => {});
        }
      })();

      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "close",
        },
      });
    }),
  ],
});
