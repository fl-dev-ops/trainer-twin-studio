/**
 * Variant Style-Card: Single-Pass Conversational Agent with Persona Voice Card
 *
 * ARCHITECTURAL PRINCIPLE:
 * - Style is not searched on ChromaDB on every turn (which is slow and guesses before intent is known).
 * - Instead, any trainer's persona has a compiled "Voice Card" (speech habits, doubled affirmations, tag questions,
 *   scaffolding scenarios, and 4-5 real exemplar quotes) injected into the prompt.
 * - The candidate's name is locked from what they say in the transcript, so background documents NEVER bleed in.
 * - Generates directly in ~1.5s with live token streaming to LiveKit/TTS.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { getAgentConfigForAgent } from "@/lib/specs";
import { env } from "@/env";
import { buildSpecs, type CompiledSpecs } from "@/lib/runtime/compiler";
import {
  type InterviewAction,
  type RuntimeState,
  deterministicFallback,
  extractLearnerName,
  initRuntimeState,
  recordAskedQuestion,
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
      this.stages.push({ stage, ms, promptTokens: prompt, completionTokens: completion });
    },
    totals() {
      return { ...totals };
    },
  };
}

function computeRequestHash(token: string, messages: any[]): string {
  const norm = JSON.stringify(messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content.trim() : m.content })));
  return createHash("sha256").update(`${token}:${norm}`).digest("hex");
}

function transcriptText(transcript: Array<{ role: string; text: string }>): string {
  return transcript.map((t) => `${t.role === "trainer" ? "Interviewer" : "Candidate"}: ${t.text}`).join("\n");
}

/**
 * Builds a trainer-agnostic Voice Card.
 * Works for any trainer in the database using their metadata, primer statistics, and exemplar quotes.
 */
function buildTrainerVoiceCard(persona: CompiledSpecs["persona"]): string {
  const name = persona.name || "Trainer";
  // Default Vasanth Voice Card compiled from clean transcripts (01.yaml, 05.yaml, 17.yaml)
  if (persona.id.toLowerCase().includes("vasanth") || persona.name.toLowerCase().includes("vasanth")) {
    return `=== ${name.toUpperCase()}'S VOICE CARD (SPEAKING STYLE RULES) ===
You MUST speak in ${name}'s exact voice, rhythm, and conversational mannerisms:
1. AFFIRMATIONS: Use natural doubled or tripled words when acknowledging:
   - "Good, good."
   - "True, true, true."
   - "Correct, correct."
   - "Sure, sure."
   - "Right, right."
2. TAG QUESTIONS: Frequently end your thoughts and checks with tag questions:
   - ", correct?"
   - ", right?"
   - ", am I right or wrong?"
   - ", okay?"
3. PRACTICAL SCAFFOLDING (MENTAL MODELS): Do not ask sterile textbook questions. Instead, set up concrete practical scenarios:
   - "Let's say you have created a file called one.js... whenever you run this on the browser, what all operations take place?"
   - "Let's consider we have comments from one to ten... when a new comment gets added, where to show it? On top or bottom?"
4. COACHING & HINTS: When the candidate is stuck, hesitates, or asks for a hint, DO NOT dismiss them. Give a gentle conceptual nudge to help them think like an engineer:
   - "See, according to me... what if we only send what came after their last comment? What do you think?"
5. RESPECT THE CANDIDATE:
   - Address the candidate by their ACTUAL NAME from the conversation (NOT any name mentioned in background resume files).
   - Only ask ONE focused, clear question at a time. Keep responses concise (under 60 words).`;
  }

  // Generic Voice Card for any other trainer
  return `=== ${name.toUpperCase()}'S VOICE CARD ===
1. Speak directly as ${name} in natural spoken dialogue.
2. Tone: ${persona.style?.tone ?? "professional, demanding but encouraging"}.
3. Address the candidate by their actual stated name.
4. Ask exactly ONE focused question per turn. Keep responses under 50 words.`;
}

async function callOpenRouterStream(
  stage: string,
  messages: Array<{ role: string; content: string }>,
  usageSink?: UsageSink,
  onDelta?: (token: string) => void
): Promise<string> {
  const model = getRuntimeModel();
  const start = performance.now();
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://trainertwin.com",
      "X-Title": "TrainerTwin Runtime Style-Card",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 300,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${stage} failed HTTP ${res.status}: ${errorText}`);
  }

  let fullContent = "";
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (dataStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              onDelta?.(delta);
            }
          } catch {}
        }
      }
    }
  }

  const duration = Math.round(performance.now() - start);
  usageSink?.add(stage, duration, {
    prompt_tokens: Math.round(JSON.stringify(messages).length / 4),
    completion_tokens: Math.round(fullContent.length / 4),
    total_tokens: Math.round((JSON.stringify(messages).length + fullContent.length) / 4),
  });

  return fullContent;
}

export async function handleCompletions(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: { message: "Unauthorized", type: "auth_error" } }, { status: 401 });
  }
  const sessionToken = authHeader.slice(7).trim();
  const session = await authorizeRuntimeSession(sessionToken);
  if (!session) {
    return Response.json({ error: { message: "Invalid session token", type: "auth_error" } }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    messages?: Array<{ role: string; content: string }>;
    stream?: boolean;
    tools?: any[];
  };
  const { messages = [], stream = true, tools = [] } = body;
  const requestHash = computeRequestHash(sessionToken, messages);

  // Compile specs
  let configSnapshot = session.compiledSnapshot as Parameters<typeof buildSpecs>[0] | null;
  if (!configSnapshot) {
    configSnapshot = await getAgentConfigForAgent(session.agentId, session.orgId, session.contextId ?? undefined);
    if (!configSnapshot) {
      return Response.json({ error: { message: "Session spec unavailable", type: "server_error" } }, { status: 500 });
    }
  }
  const specs = buildSpecs(configSnapshot);

  const state: RuntimeState = (session.runtimeState && typeof session.runtimeState === "object" && !Array.isArray(session.runtimeState)
    ? { ...session.runtimeState }
    : initRuntimeState()) as RuntimeState;

  // STRICT CANDIDATE NAME LOCK: Extract name strictly from user speech, NEVER from resume metadata
  const userTurns = messages.filter((m) => m.role === "user");
  if (!state.learner_name && userTurns.length) {
    const candidateSpeech = userTurns.map((m) => m.content).join("\n");
    state.learner_name = extractLearnerName(candidateSpeech);
  }
  const learnerName = state.learner_name || "there";

  const transcript = (session.transcript && Array.isArray(session.transcript)
    ? [...(session.transcript as Array<{ role: "user" | "trainer"; text: string }>)]
    : []) as Array<{ role: "user" | "trainer"; text: string }>;

  const lastUserMessage = userTurns[userTurns.length - 1]?.content ?? "";
  if (lastUserMessage && transcript[transcript.length - 1]?.text !== lastUserMessage) {
    transcript.push({ role: "user", text: lastUserMessage });
  }

  const isOpeningTurn = messages.length <= 1 && (!lastUserMessage || lastUserMessage === "session-start");
  const completionId = `chatcmpl-${createHash("md5").update(requestHash).digest("hex").slice(0, 12)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const usageSink = createUsageSink();

  if (isOpeningTurn) {
    const openingText = `Hi ${learnerName}. As you know, I'm ${specs.persona.name}. Thanks for joining the interview today. Can I know a bit about you and your recent experience—whatever you'd like to share? What are your skill sets and what sort of roles are you targeting?`;
    transcript.push({ role: "trainer", text: openingText });

    void db.interviewSession.update({
      where: { id: session.id },
      data: {
        runtimeState: state as any,
        transcript: transcript as any,
        runtimeRevision: (session.runtimeRevision ?? 0) + 1,
      },
    }).catch(() => {});

    if (stream) {
      const streamBody = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: { role: "assistant", content: openingText }, finish_reason: null }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } });
    }
    return Response.json({
      id: completionId,
      object: "chat.completion",
      created: timestamp,
      model: "trainertwin-runtime",
      choices: [{ index: 0, message: { role: "assistant", content: openingText }, finish_reason: "stop" }],
    });
  }

  // Handle Repeat Request immediately
  if (/^(repeat|can you repeat|pardon|sorry repeat|what did you say)\b/i.test(lastUserMessage.trim())) {
    const lastTrainerTurn = [...transcript].reverse().find((t) => t.role === "trainer")?.text;
    const repeatText = lastTrainerTurn ? `Sure, no problem. I was asking: ${lastTrainerTurn}` : "Sure, can you walk me through your primary project experience?";
    if (stream) {
      const streamBody = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: { role: "assistant", content: repeatText }, finish_reason: null }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } });
    }
    return Response.json({
      id: completionId,
      object: "chat.completion",
      created: timestamp,
      model: "trainertwin-runtime",
      choices: [{ index: 0, message: { role: "assistant", content: repeatText }, finish_reason: "stop" }],
    });
  }

  // CONVERSATIONAL SPEECH GENERATION WITH PERSONA VOICE CARD
  const voiceCard = buildTrainerVoiceCard(specs.persona);
  const phase = specs.agent.phases[state.phase_index] ?? null;

  const systemPrompt = `You are ${specs.persona.name}, conducting a live technical mock interview.
The candidate sitting across from you is named "${learnerName}". Always address them as "${learnerName}". Never invent another name.

${voiceCard}

INTERVIEW CONTEXT:
Scenario: ${specs.agent.name}
Objective: ${specs.agent.objective}
Active phase: ${phase?.name ?? "Deep Dive"} - ${phase?.objective ?? "Evaluate technical depth and ownership"}

CONVERSATIONAL RULES:
1. Act like an authentic, highly experienced technical interviewer. Listen to what the candidate just said.
2. If the candidate answered partially, probe deeper on the technical mechanism or trade-off.
3. If the candidate gave a false claim or contradicted themselves, gently challenge them using a scenario ("Let's say...").
4. If the candidate asks for a hint, give a constructive conceptual hint. Do NOT dismiss them or repeat a dry question.
5. If the candidate asks to explore another part of their architecture, follow their lead rather than repeating a prior question.
6. Keep your response spoken-first, concise (<50 words), and ask exactly ONE focused question.`;

  const userPrompt = `Conversation History:
${transcriptText(transcript)}

Candidate's latest utterance:
"${lastUserMessage}"

Respond as ${specs.persona.name} directly to the candidate:`;

  if (stream) {
    let accumulated = "";
    const streamBody = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          await callOpenRouterStream(
            "voice_card_generation",
            [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            usageSink,
            (delta) => {
              accumulated += delta;
              controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: { role: "assistant", content: delta }, finish_reason: null }] })}\n\n`));
            }
          );
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();

          // Save transcript and state asynchronously
          transcript.push({ role: "trainer", text: accumulated });
          state.learner_turns = (state.learner_turns ?? 0) + 1;
          void db.interviewSession.update({
            where: { id: session.id },
            data: {
              runtimeState: state as any,
              transcript: transcript as any,
              runtimeRevision: (session.runtimeRevision ?? 0) + 1,
            },
          }).catch(() => {});
        } catch (err) {
          controller.error(err);
        }
      },
    });
    return new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } });
  }

  // Non-streaming
  const spokenText = await callOpenRouterStream(
    "voice_card_generation",
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    usageSink
  );
  transcript.push({ role: "trainer", text: spokenText });
  state.learner_turns = (state.learner_turns ?? 0) + 1;

  void db.interviewSession.update({
    where: { id: session.id },
    data: {
      runtimeState: state as any,
      transcript: transcript as any,
      runtimeRevision: (session.runtimeRevision ?? 0) + 1,
    },
  }).catch(() => {});

  return Response.json({
    id: completionId,
    object: "chat.completion",
    created: timestamp,
    model: "trainertwin-runtime",
    choices: [{ index: 0, message: { role: "assistant", content: spokenText }, finish_reason: "stop" }],
  });
}
