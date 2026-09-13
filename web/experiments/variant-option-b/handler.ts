/**
 * Variant Option-B: "Fast Move First → Targeted Style" Conversational Agent
 *
 * ARCHITECTURE (3 fast steps):
 * 1. FAST MOVE (single tiny LLM call ~0.6-0.8s): Classify the candidate's last utterance into
 *    a concrete conversational move (probe deeper, challenge false claim, give hint,
 *    acknowledge metrics, transition topic). Output ONE sentence describing the move.
 * 2. TARGETED STYLE RETRIEVAL (~0.8-1.2s): Search the TRAINER'S OWN ChromaDB style vector
 *    store with a query built FROM the move ("trainer challenging candidate's false claim
 *    about Kafka ordering") so examples match the situation.
 * 3. SPEAK AS TRAINER (~1.2-1.6s): Generate the spoken response in the trainer's voice
 *    using retrieved style examples as the cadence/wording guide.
 *
 * Everything is trainer-agnostic: works for ANY trainer with an indexed style store.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { getAgentConfigForAgent } from "@/lib/specs";
import { env } from "@/env";
import { buildSpecs, type CompiledSpecs } from "@/lib/runtime/compiler";
import { MainCollectionService } from "@/lib/main-collection";
import {
  type RuntimeState,
  extractLearnerName,
  initRuntimeState,
  wordCount,
} from "@/lib/runtime/runtime";
import { redactLearnerNames } from "@/lib/persona-voice";

const REPEAT_RE = /\b(repeat|say that again|could(?:n't| not) hear|can(?:'t| not) hear|speak (?:more )?slowly)\b/i;

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

type PersonaRecordHit = Awaited<ReturnType<typeof MainCollectionService.searchStyleEpisodes>>[number];

async function callOpenRouter(
  stage: string,
  messages: Array<{ role: string; content: string }>,
  options: { temperature?: number; maxTokens?: number; usage?: UsageSink } = {}
): Promise<{ text: string; usage: CompletionUsage | null; ms: number }> {
  const model = getRuntimeModel();
  const start = performance.now();
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://trainertwin.com",
      "X-Title": "TrainerTwin Runtime (Option-B)",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 300,
    }),
  });
  const ms = Math.round(performance.now() - start);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${stage} failed HTTP ${res.status}: ${errorText}`);
  }
  const data = (await res.json()) as any;
  const usage = data.usage ?? null;
  options.usage?.add(stage, ms, usage);
  return { text: String(data.choices?.[0]?.message?.content ?? ""), usage, ms };
}

/**
 * STEP 1 — FAST MOVE: tiny prompt classifies the trainer's conversational move.
 * Returns both the move type and a retrieval query.
 */
async function classifyMove(
  specs: CompiledSpecs,
  state: RuntimeState,
  transcript: Array<{ role: string; text: string }>,
  latestUserText: string,
  usage?: UsageSink
): Promise<{ move: string; retrievalQuery: string }> {
  const phase = specs.agent.phases[state.phase_index] ?? null;
  const prompt = `You are the conversation controller for a live technical mock interview.

Trainer objective: ${specs.agent.objective}
Active phase: ${phase?.name ?? "Deep dive"} — ${phase?.objective ?? "evaluate depth and ownership"}
Pending trainer question: ${state.pending_question ?? "none"}
Recent transcript:
${transcriptText(transcript.slice(-6))}

Candidate's latest message: "${latestUserText}"

Decide the trainer's conversational MOVE for the next response. Choose exactly one:
- "probe": candidate answered; dig into the concrete mechanism, design, or their personal role.
- "challenge": candidate made a false/unsupported technical claim; test it.
- "hint": candidate is stuck, confused, or asked for help; give a gentle conceptual nudge.
- "acknowledge_advance": candidate shared results/metrics or completed a thought; acknowledge and move to the next area.
- "clarify": candidate asked a question about the interview itself; answer it briefly and return.
- "redirect": candidate went off track from the objective; bring them back kindly.
- "close": candidate signalled they are done; wrap up the session.

Return JSON only:
{"move": "<one of the moves above>", "retrieval_query": "<topic-neutral description of this conversational situation for searching how the trainer handled similar moments; e.g. 'interviewer challenging candidate who overclaims exactly-once delivery guarantees' or 'interviewer giving hint to stuck junior candidate'>", "focus": "<the specific technical topic or claim to focus the next question on>"}`;

  try {
    const { text } = await callOpenRouter("fast_move", [
      { role: "system", content: "You are a strict conversation controller. Output valid JSON only." },
      { role: "user", content: prompt },
    ], { temperature: 0.1, maxTokens: 200, usage });
    const parsed = JSON.parse(text) as { move?: string; retrieval_query?: string };
    const validMoves = new Set(["probe", "challenge", "hint", "acknowledge_advance", "clarify", "redirect", "close"]);
    return {
      move: validMoves.has(parsed.move ?? "") ? parsed.move! : "probe",
      retrievalQuery: (parsed.retrieval_query ?? `${parsed.move ?? "probe"} on ${latestUserText.slice(0, 80)}`).trim(),
    };
  } catch {
    return { move: "probe", retrievalQuery: `probe ${latestUserText.slice(0, 80)}` };
  }
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
  };
  const { messages = [], stream = true } = body;
  const requestHash = computeRequestHash(sessionToken, messages);

  let configSnapshot = session.compiledSnapshot as Parameters<typeof buildSpecs>[0] | null;
  if (!configSnapshot) {
    configSnapshot = await getAgentConfigForAgent(session.agentId, session.orgId, session.contextId ?? undefined);
    if (!configSnapshot) {
      return Response.json({ error: { message: "Session spec unavailable", type: "server_error" } }, { status: 500 });
    }
  }
  const specs = buildSpecs(configSnapshot);

  const state: RuntimeState = {
    ...initRuntimeState(),
    ...((session.runtimeState as Partial<RuntimeState> | null) ?? {}),
  };

  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMessage = (userMessages[userMessages.length - 1]?.content ?? "").trim();
  const isOpeningTurn = state.learner_turns === 0 && !lastUserMessage;
  const completionId = `chatcmpl-${createHash("md5").update(requestHash).digest("hex").slice(0, 12)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const usageSink = createUsageSink();

  const transcript: Array<{ role: "user" | "trainer"; text: string }> = Array.isArray(session.transcript)
    ? [...(session.transcript as Array<{ role: "user" | "trainer"; text: string }>)]
    : [];

  // Lock the learner's name from what they SAY (never from resume documents)
  if (!state.learner_name && lastUserMessage) {
    state.learner_name = extractLearnerName(lastUserMessage);
  }
  // Only inject a name when one is actually known — a fake placeholder ("there") would
  // override the real name the model can read in the transcript.
  const learnerName = state.learner_name || null;

  const persist = (spokenText: string) => {
    const nextTranscript = [...transcript];
    if (lastUserMessage && !isOpeningTurn) nextTranscript.push({ role: "user", text: lastUserMessage });
    if (spokenText) nextTranscript.push({ role: "trainer", text: spokenText });
    state.learner_turns = (state.learner_turns ?? 0) + (isOpeningTurn ? 0 : 1);
    return db.interviewSession.update({
      where: { id: session.id },
      data: {
        runtimeState: state as any,
        transcript: nextTranscript as any,
        runtimeRevision: (session.runtimeRevision ?? 0) + 1,
      },
    }).catch((err) => console.error("[interview-runtime] async persist error:", err));
  };

  const sseFromText = (text: string, oneShot: boolean) => {
    const enc = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: { role: "assistant", content: oneShot ? text : null }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };

  // ---------------- OPENING TURN ----------------
  if (isOpeningTurn) {
    const phase = specs.agent.phases[0];
    const openingText = `Hi${learnerName ? ` ${learnerName}` : ""}. As you know, I'm ${specs.persona.name}. Thanks for registering for the mock interview. Can I know something about you — whatever you wish to share? What are your skill sets, and what sort of roles are you aspiring for at the moment?`;
    await persist(openingText);
    return stream ? sseFromText(openingText, true) : Response.json({
      id: completionId, object: "chat.completion", created: timestamp, model: "trainertwin-runtime",
      choices: [{ index: 0, message: { role: "assistant", content: openingText }, finish_reason: "stop" }],
    });
  }

  // ---------------- REPEAT REQUEST ----------------
  if (REPEAT_RE.test(lastUserMessage) && state.pending_question) {
    const repeatText = `Sure, no problem. I was asking: ${state.pending_question}`;
    await persist(repeatText);
    return stream ? sseFromText(repeatText, true) : Response.json({
      id: completionId, object: "chat.completion", created: timestamp, model: "trainertwin-runtime",
      choices: [{ index: 0, message: { role: "assistant", content: repeatText }, finish_reason: "stop" }],
    });
  }

  // ---------------- STEP 1: FAST MOVE ----------------
  const { move, retrievalQuery } = await classifyMove(specs, state, transcript, lastUserMessage, usageSink);

  // ---------------- STEP 2: TARGETED STYLE RETRIEVAL ----------------
  let styleExamples: PersonaRecordHit[] = [];
  try {
    styleExamples = await MainCollectionService.searchStyleEpisodes(session.orgId, retrievalQuery, {
      personaId: specs.persona.id,
      limit: 8,
      diversify: true,
    });
  } catch (error) {
    console.warn("[interview-runtime] style retrieval failed; speaking without examples", error);
  }

  // Rotation: prefer examples not used in recent turns so no top-k set dominates.
  const recent = new Set((state.recent_style_docs as string[] | undefined) ?? []);
  const fingerprint = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
  const fresh = styleExamples.filter((hit) => !recent.has(fingerprint(hit.text)));
  const ordered = [...fresh, ...styleExamples.filter((hit) => recent.has(fingerprint(hit.text)))];
  styleExamples = ordered.slice(0, 5);
  for (const hit of styleExamples) recent.add(fingerprint(hit.text));
  state.recent_style_docs = [...recent].slice(-12);

  // Name redaction: stored examples may contain a PAST learner's real name (e.g. "Harini")
  // or the current learner's name. Replace both with <name> so the prompt never carries a
  // wrong identity, and tell the agent <name> means the current learner.
  const redactedExamples = styleExamples.map((hit) => ({
    hit,
    text: learnerName
      ? redactLearnerNames(redactLearnerNames(hit.text, [hit.pastLearnerName]), [learnerName])
      : redactLearnerNames(hit.text, [hit.pastLearnerName]),
  }));

  // ---------------- STEP 3: SPEAK AS TRAINER ----------------
  const phase = specs.agent.phases[state.phase_index] ?? null;
  const examplesBlock = redactedExamples.length
    ? redactedExamples.map(({ hit, text }) => {
        const why = [
          hit.sessionPhase ? `phase: ${hit.sessionPhase}` : "",
          hit.styleFunction ? `speech function: ${hit.styleFunction}` : "",
          hit.styleShape ? `sentence shape: ${hit.styleShape}` : "",
          hit.learnerState ? `learner state: ${hit.learnerState}` : "",
        ].filter(Boolean).join(" | ");
        return `- ${why ? `(${why}) ` : ""}${text.slice(0, 500)}`;
      }).join("\n")
    : "(no style examples retrieved; speak naturally)";

  const identityBlock = learnerName
    ? `The candidate is "${learnerName}". Address them by this name when natural. Never use any other name — names found in resume or example documents are NOT this candidate.`
    : `The candidate's name is unknown so far. Do NOT use any name for them; listen for their introduction and use it only once they have said it.`;

  const systemPrompt = `You are ${specs.persona.name}, conducting a live voice mock interview.
${identityBlock}

YOUR DECIDED MOVE for this turn: ${move}
${state.pending_question ? `Your previous pending question: "${state.pending_question}"` : ""}

HOW YOU TALK — real examples of ${specs.persona.name}'s speech in similar situations.
Each example carries metadata explaining WHY ${specs.persona.name} said it (phase, speech function, sentence shape, learner state) — use it to understand the intent behind the wording, not to copy it:
${examplesBlock}

${learnerName ? `NOTE: "<name>" inside examples is a redacted placeholder for the learner. When you speak, replace it with the candidate's real name: "${learnerName}".` : `NOTE: "<name>" inside examples is a redacted placeholder for the learner. Since you do not know their name yet, do not address them by name at all.`}

ANTI-REPETITION:
- Look at your last 2 spoken turns below. Do NOT open this turn with the same acknowledgement pattern you used in them (if you said "Good, good" last turn, open differently — "True, true", "Okay", "Sure, sure", a paraphrase, or no acknowledgement at all).
- Vary sentence shape and rhythm across turns.

RULES:
1. Match the rhythm, phrasing habits, and tone of the examples above (they are ${specs.persona.name}'s actual past speech).
2. Execute the decided move: ${move}.
3. Ask exactly ONE focused question. Keep it under 50 words, spoken-first (no markdown).
4. If the move is "hint", give a genuine conceptual nudge, not a repeat of the question.`;

  const userPrompt = `Conversation so far:
${transcriptText(transcript)}

Candidate just said: "${lastUserMessage}"

Respond as ${specs.persona.name}:`;

  const generation = await callOpenRouter("styled_generation", [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], { temperature: 0.4, maxTokens: 250, usage: usageSink });

  const spokenText = generation.text.trim();
  if (!state.pending_question) state.pending_question = spokenText;
  else {
    // track pending question only if the move asked one
    if (move === "probe" || move === "challenge" || move === "redirect" || move === "acknowledge_advance") {
      state.pending_question = spokenText;
    }
  }

  await persist(spokenText);

  if (stream) {
    // Stream the final text word by word for low perceived latency
    const enc = new TextEncoder();
    const words = spokenText.split(/(\s+)/);
    const streamBody = new ReadableStream({
      async start(controller) {
        for (const word of words) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: { role: "assistant", content: word }, finish_reason: null }] })}\n\n`));
          await new Promise((r) => setTimeout(r, 12));
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "trainertwin-runtime", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return streamBody;
  }

  return Response.json({
    id: completionId,
    object: "chat.completion",
    created: timestamp,
    model: "trainertwin-runtime",
    usage: usageSink.totals(),
    choices: [{ index: 0, message: { role: "assistant", content: spokenText }, finish_reason: "stop" }],
  });
}
