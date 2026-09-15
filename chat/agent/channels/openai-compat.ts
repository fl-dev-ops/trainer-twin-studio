import { defineChannel, POST, type Session } from "eve/channels";
import { studioPrincipal } from "../lib/auth";

/**
 * OpenAI-compatible chat completions bridge. This endpoint allows LiveKit
 * (or any standard OpenAI client) to use the Eve agent as the conversational brain.
 *
 * - LiveKit acts purely as transport: STT/TTS + room RPC tool execution.
 * - Eve owns persona fidelity, scenario grounding, move decisions, and retrieval.
 * - Streams standard SSE `chat.completion.chunk` events (content deltas, tool_calls, usage).
 * - On HTTP abort (learner barge-in), triggers cooperative session cancellation.
 */

/** Tools executed by the transport (Python) over room RPC — forwarded as tool_calls. */
const TRANSPORT_TOOLS = new Set([
  "surface",
  "finish_session",
  "workspace_request",
  "read_canvas_scene",
  "highlight_canvas_element",
  "add_canvas_component",
  "clear_canvas",
  "read_code_range",
  "highlight_code",
  "highlight_whiteboard",
  "get_code_state",
  "run_code",
  "get_presentation_state",
  "set_presentation_slide",
  "next_presentation_slide",
  "previous_presentation_slide",
]);

/** Pure side-effect transport tools that do not require conversational follow-up speech. */
const PURE_SIDE_EFFECT_TOOLS = new Set([
  "surface",
  "finish_session",
  "clear_canvas",
  "highlight_code",
  "highlight_whiteboard",
  "highlight_canvas_element",
]);

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
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
  const latest = [...(messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.role === "user" ||
        message.role === "tool" ||
        contentToText(message.content).trim() === "session-start",
    );
  if (!latest) return null;
  if (latest.role === "tool") {
    return `[TOOL RESULT] ${latest.tool_call_id ?? ""} ${latest.name ?? ""}\n${contentToText(latest.content)}`;
  }
  const text = contentToText(latest.content).trim();
  if (!text) return null;
  // LiveKit's generate_reply("session-start") maps to the opening brief.
  return text === "session-start" ? "[OPENING] Generate the session opening." : text;
}

type StreamEvent = {
  type: string;
  data: Record<string, unknown> & {
    messageDelta?: string;
    actions?: { kind: string; callId: string; toolName: string; input: unknown }[];
    usage?: { inputTokens?: number; outputTokens?: number };
  };
};

export default defineChannel({
  routes: [
    POST("/v1/chat/completions", async (request, { from, resolveSession }) => {
      const principal = studioPrincipal(request);
      const orgHeader = request.headers.get("x-trainertwin-org-id")?.trim();
      const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();

      const orgId = principal?.principalId ?? orgHeader;
      if (!orgId) {
        return Response.json({ error: "Organization is required" }, { status: 401 });
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
        ...(requestedModel ? { model: requestedModel } : {}),
      };
      const agentSlug = request.headers.get("x-trainertwin-agent-slug")?.trim();
      const personaSlug = request.headers.get("x-trainertwin-persona-slug")?.trim();
      if (agentSlug) attributes.agentSlug = agentSlug;
      if (personaSlug) attributes.personaSlug = personaSlug;

      const auth = {
        attributes,
        authenticator: principal?.authenticator ?? "openai-compat",
        principalId: orgId,
        principalType: "organization",
      };

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
        let sawToolCall = false;
        let sawActivity = false;
        let sawTurnStarted = false;
        let toolIndex = 0;
        let ttftMs: number | null = null;
        let tFirstEvent = 0;
        let usage: { inputTokens?: number; outputTokens?: number } | null = null;
        const allToolsCalled: { name: string; callId: string; input: unknown }[] = [];
        const finishReason = () => (sawToolCall ? "tool_calls" : "stop");

        try {
          while (true) {
            const { done, value: event } = await reader.read();
            if (done) break;
            const ev = event as StreamEvent;
            if (!tFirstEvent) tFirstEvent = Date.now() - t_start;

            if (ev.type === "turn.started") {
              sawTurnStarted = true;
            }

            // Text deltas
            if (ev.type === "message.appended" && typeof ev.data.messageDelta === "string") {
              if (ttftMs === null) {
                ttftMs = Date.now() - t_start;
              }
              sawActivity = true;
              await writeChunk({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: ev.data.messageDelta }, finish_reason: null }],
              });
              continue;
            }

            // Tool execution requests
            if (ev.type === "actions.requested" && Array.isArray(ev.data.actions)) {
              for (const action of ev.data.actions) {
                if (action.kind !== "tool-call") continue;
                allToolsCalled.push({ name: action.toolName, callId: action.callId, input: action.input });

                if (!TRANSPORT_TOOLS.has(action.toolName)) continue;
                // If client advertised tools, only forward tools the client advertised
                if (advertisedTools.size > 0 && !advertisedTools.has(action.toolName)) continue;

                sawActivity = true;
                sawToolCall = true;
                await writeChunk({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex++,
                        id: action.callId,
                        type: "function",
                        function: { name: action.toolName, arguments: JSON.stringify(action.input ?? {}) },
                      }],
                    },
                    finish_reason: null,
                  }],
                });
              }
              continue;
            }

            if (ev.type === "step.completed" && ev.data.usage) {
              usage = ev.data.usage;
              continue;
            }

            const terminal =
              (sawTurnStarted && ev.type === "session.waiting") ||
              ev.type === "turn.cancelled" ||
              ev.type === "session.failed" ||
              ev.type === "session.completed";

            if (terminal && (sawActivity || sawTurnStarted)) {
              const wallMs = Date.now() - t_start;
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
                ttft_ms: ttftMs ?? wallMs,
                wall_ms: wallMs,
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
