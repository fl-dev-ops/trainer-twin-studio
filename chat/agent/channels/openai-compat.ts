import { defineChannel, POST, type Session } from "eve/channels";
import { studioPrincipal } from "../lib/auth";

/**
 * OpenAI-compatible chat completions bridge. This is the endpoint a LiveKit
 * transport (or any OpenAI-protocol client) can point at to use the eve agent
 * as the conversational brain. LiveKit acts purely as transport: it executes
 * the workspace tool calls the brain emits, and the brain owns all reasoning,
 * persona fidelity, and retrieval.
 *
 * Session identity: the caller's `x-trainertwin-session-id` header (or the
 * Bearer token) is the channel-local continuation address, so one runtime
 * token maps to one durable eve session that holds the whole conversation.
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
  "get_code_state",
  "run_code",
  "get_presentation_state",
  "set_presentation_slide",
  "next_presentation_slide",
  "previous_presentation_slide",
]);

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_call_id?: string;
  name?: string;
};

type ChatCompletionBody = {
  messages?: ChatMessage[];
  stream?: boolean;
  model?: string;
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

/**
 * Maps the incoming chat-completions messages to ONE eve turn input: only the
 * newest user or tool message matters — the eve session already holds the full
 * durable history.
 */
function mapLatestMessage(messages: ChatMessage[]): string | null {
  const latest = [...(messages ?? [])].reverse().find((message) => message.role === "user" || message.role === "tool");
  if (!latest) return null;
  if (latest.role === "tool") {
    return `[TOOL RESULT] ${latest.tool_call_id ?? ""} ${latest.name ?? ""}\n${contentToText(latest.content)}`;
  }
  const text = contentToText(latest.content).trim();
  if (!text) return null;
  // LiveKit's generate_reply("session-start") trigger maps to the opening brief.
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
      // LiveKit sends `Authorization: Bearer <runtime-token>`; the studio Basic
      // principal is the strong path, header org + Bearer token is the fallback.
      const orgId = principal?.principalId ?? orgHeader;
      if (!orgId) {
        return Response.json({ error: "Organization is required" }, { status: 401 });
      }
      const principalForSession: NonNullable<typeof principal> = principal ?? {
        attributes: { orgId },
        authenticator: "openai-compat",
        principalId: orgId,
        principalType: "organization",
      };

      const body = (await request.json().catch(() => null)) as ChatCompletionBody | null;
      const message = mapLatestMessage(body?.messages ?? []);
      if (!message) return Response.json({ error: "No user or tool message to process" }, { status: 400 });

      const attributes: Record<string, string> = { orgId };
      const agentSlug = request.headers.get("x-trainertwin-agent-slug")?.trim();
      const personaSlug = request.headers.get("x-trainertwin-persona-slug")?.trim();
      if (agentSlug) attributes.agentSlug = agentSlug;
      if (personaSlug) attributes.personaSlug = personaSlug;
      const auth = { ...principalForSession, attributes };

      // Address = durable conversation. One runtime token / session id maps to
      // one eve session holding the full history.
      const address = request.headers.get("x-trainertwin-session-id")?.trim() || `token:${bearer || "anonymous"}`;
      const existing = await resolveSession(address);
      let session: Session;
      let tailIndex: number | undefined;
      if (existing) {
        // Capture the stream tail BEFORE sending so the event stream replays
        // nothing from earlier turns and ends at THIS turn's completion.
        tailIndex = await existing.getStreamTailIndex();
        await existing.send(message, { auth });
        session = existing;
      } else {
        session = await from(address).send(message, { auth });
      }

      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body?.model ?? "trainertwin-brain";
      // ponytail: events between send() acceptance and getEventStream() attach
      // can be missed; the tail-index capture before send() keeps the window
      // down to dispatch-internal latency.
      const stream = await session.getEventStream(tailIndex === undefined ? {} : { startIndex: tailIndex });
      const reader = stream.getReader();

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const writeChunk = (payload: unknown) => writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

      void (async () => {
        let sawToolCall = false;
        let sawActivity = false;
        let toolIndex = 0;
        let usage: { inputTokens?: number; outputTokens?: number } | null = null;
        const finishReason = () => (sawToolCall ? "tool_calls" : "stop");
        try {
          while (true) {
            const { done, value: event } = await reader.read();
            if (done) break;
            const ev = event as StreamEvent;
            if (ev.type === "message.appended" && typeof ev.data.messageDelta === "string") {
              sawActivity = true;
              await writeChunk({ id: completionId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: ev.data.messageDelta }, finish_reason: null }] });
              continue;
            }
            if (ev.type === "actions.requested" && Array.isArray(ev.data.actions)) {
              for (const action of ev.data.actions) {
                if (action.kind !== "tool-call" || !TRANSPORT_TOOLS.has(action.toolName)) continue;
                sawActivity = true;
                sawToolCall = true;
                await writeChunk({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { tool_calls: [{ index: toolIndex++, id: action.callId, type: "function", function: { name: action.toolName, arguments: JSON.stringify(action.input ?? {}) } }] },
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
            const terminal = ev.type === "turn.completed" || ev.type === "turn.failed" || ev.type === "turn.cancelled" || ev.type === "session.failed" || ev.type === "session.completed";
            if (terminal && (sawActivity || ev.type === "turn.completed")) {
              await writeChunk({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason() }],
                ...(usage ? { usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } } : {}),
              });
              break;
            }
          }
        } catch {
          // Stream errors fall through to finally; the transport retries per turn.
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
          connection: "keep-alive",
        },
      });
    }),
  ],
});
