import { createHash } from "node:crypto";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  stream?: boolean;
}

interface CachedTurn {
  responseBody: unknown;
  sseChunks?: unknown[];
  executionCount: number;
}

// In-memory idempotency cache for Step 1 protocol shell
// In Step 2 & 3, this is backed by InterviewSession.lastCompletion
const protocolCache = new Map<string, CachedTurn>();
let globalExecutionCounter = 0;

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

import { handleCompletions } from "@/lib/runtime/openai";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return Response.json(
      { error: { message: "Unauthorized: Missing runtime token", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  if (!token.startsWith("test-token")) {
    return handleCompletions(request);
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

  const { model = "trainertwin-runtime", messages = [], stream = true } = body;
  const requestHash = computeRequestHash(token, messages);

  // Idempotency check: if identical messages + token received, return cached response
  const cached = protocolCache.get(requestHash);
  if (cached) {
    if (stream && cached.sseChunks) {
      return new Response(buildSseStream(cached.sseChunks), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Idempotent-Replay": "true",
          "X-Execution-Count": String(cached.executionCount),
        },
      });
    }
    return Response.json(cached.responseBody, {
      headers: {
        "X-Idempotent-Replay": "true",
        "X-Execution-Count": String(cached.executionCount),
      },
    });
  }

  // Not cached: increment execution counter (used to verify no double-grading on retry)
  globalExecutionCounter += 1;
  const executionNumber = globalExecutionCounter;

  const timestamp = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${createHash("md5").update(requestHash).digest("hex").slice(0, 12)}`;

  const toolMessages = messages.filter((m) => m.role === "tool");
  const isToolResponseTurn = toolMessages.length > 0;

  let sseChunks: unknown[];
  let fullResponse: unknown;

  if (!isToolResponseTurn) {
    // Phase 1 / Step 1 fake engine: emit 2 parallel tool calls
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
                  id: "call_test_1",
                  type: "function",
                  function: {
                    name: "test_tool_1",
                    arguments: JSON.stringify({ action: "ping1" }),
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
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_test_2",
                  type: "function",
                  function: {
                    name: "test_tool_2",
                    arguments: JSON.stringify({ action: "ping2" }),
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
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
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
                id: "call_test_1",
                type: "function",
                function: { name: "test_tool_1", arguments: JSON.stringify({ action: "ping1" }) },
              },
              {
                id: "call_test_2",
                type: "function",
                function: { name: "test_tool_2", arguments: JSON.stringify({ action: "ping2" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
  } else {
    // Final spoken text response after tools have executed
    const toolContents = toolMessages.map((m) => m.content ?? "").join(", ");
    const spokenText = `Both tools finished successfully: ${toolContents}`;

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
              content: spokenText,
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
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
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
            content: spokenText,
          },
          finish_reason: "stop",
        },
      ],
    };
  }

  // Record into idempotency cache
  protocolCache.set(requestHash, {
    responseBody: fullResponse,
    sseChunks,
    executionCount: executionNumber,
  });

  if (stream) {
    return new Response(buildSseStream(sseChunks), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Execution-Count": String(executionNumber),
      },
    });
  }

  return Response.json(fullResponse, {
    headers: {
      "X-Execution-Count": String(executionNumber),
    },
  });
}
