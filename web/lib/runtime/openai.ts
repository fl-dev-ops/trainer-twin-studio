/**
 * OpenAI Chat Completions runtime adapter.
 * Handles POST /api/v1/chat/completions by delegating to compiler & runtime.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { getAgentConfigForAgent } from "@/lib/specs";
import { searchKnowledge } from "@/lib/knowledge";
import { MainCollectionService } from "@/lib/main-collection";
import { env } from "@/env";
import { buildSpecs, type CompiledSpecs } from "./compiler";
import {
  type AnswerAnalysis,
  type InterviewAction,
  type RuntimeState,
  activeAllowedActions,
  applyPersonaVote,
  closingAction,
  deterministicFallback,
  evidenceLabel,
  initRuntimeState,
  recordAskedQuestion,
  refreshCurrentTopic,
  renderRules,
  selectAction,
  surfaceForPhase,
  validateAnalysis,
  validatePersonaRewrite,
  validateRendered,
} from "./runtime";

const OPENROUTER_BASE_URL = env.OPENROUTER_BASE_URL.replace(/\/$/, "");
const RUNTIME_MODEL = env.INTERVIEW_LLM_MODEL;

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

type TranscriptTurn = { role: "user" | "trainer"; text: string };
type KnowledgeHit = { id: string; docId: string; source: string; text: string; score: number };
type PersonaMoment = { id: string; personaId: string; sourceId: string; text: string; score: number; action?: string; learnerState?: string; move?: string };

type DirectionCheck = {
  learner_intent: "answer" | "question" | "clarification" | "off_topic" | "stop";
  on_track: boolean;
  should_grade: boolean;
  current_topic: string;
  response_instruction: string;
};

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

async function callOpenRouter(
  stage: string,
  messages: { role: string; content: string }[],
  responseFormatJson = false
): Promise<string> {
  const key = env.OPENROUTER_API_KEY; // validated at startup, never missing here

  const startedAt = performance.now();
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: RUNTIME_MODEL,
      messages,
      temperature: responseFormatJson ? 0 : 0.4,
      max_tokens: responseFormatJson ? 1400 : 500,
      ...(responseFormatJson ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  console.info(`[interview-runtime] ${stage} completed`, {
    model: RUNTIME_MODEL,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return data?.choices?.[0]?.message?.content ?? "";
}

const transcriptText = (transcript: TranscriptTurn[]) =>
  transcript.map((turn) => `${turn.role === "trainer" ? "Trainer" : "Learner"}: ${turn.text}`).join("\n");

export function isRepeatRequest(direction: DirectionCheck): boolean {
  return !direction.should_grade && /restate the pending question/i.test(direction.response_instruction);
}

export function explicitCommunicationRecovery(text: string): DirectionCheck | null {
  if (/^\s*(?:please\s+)?(?:stop|end|quit|finish)(?:\s+the\s+(?:interview|session))?[.!?\s]*$/i.test(text)) {
    return { learner_intent: "stop", on_track: true, should_grade: false, current_topic: "", response_instruction: "Close the session." };
  }
  if (/\b(repeat|say that again|could(?:n't| not) hear|can(?:'t| not) hear|speak (?:more )?slowly|speak (?:a bit )?slower|are you there)\b/i.test(text)) {
    return {
      learner_intent: "clarification",
      on_track: true,
      should_grade: false,
      current_topic: "",
      response_instruction: "Acknowledge the communication issue and restate the pending question without changing its topic.",
    };
  }
  return null;
}

async function retrieveKnowledge(
  knowledgeBases: string[],
  query: string,
  orgId: string
): Promise<KnowledgeHit[]> {
  if (!knowledgeBases.length || !query.trim()) return [];
  try {
    const rows = await db.knowledgeBase.findMany({
      where: {
        orgId,
        OR: [{ id: { in: knowledgeBases } }, { slug: { in: knowledgeBases } }],
      },
      select: { id: true },
    });
    const ids = rows.length ? rows.map((row) => row.id) : knowledgeBases;
    const hits = (await Promise.all(ids.map((id) => searchKnowledge(id, query, 3, orgId)))).flat();
    const unique = [...new Map(hits.map((hit) => [hit.id, hit])).values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    console.info("[interview-runtime] knowledge retrieved", { hits: unique.length });
    return unique;
  } catch (error) {
    console.warn("[interview-runtime] knowledge retrieval failed", error);
    return [];
  }
}

async function runDirectionCheck(
  learnerText: string,
  transcript: TranscriptTurn[],
  specs: CompiledSpecs,
  state: RuntimeState,
  knowledgeHits: KnowledgeHit[]
): Promise<DirectionCheck> {
  const explicit = explicitCommunicationRecovery(learnerText);
  if (explicit) return { ...explicit, current_topic: state.current_topic ?? "" };

  const phase = specs.agent.phases[state.phase_index] ?? null;
  const prompt = `Check whether the conversation is following the active interview direction.
Use the complete transcript, not only the latest message.
Agent objective: ${specs.agent.objective}
Active phase: ${JSON.stringify(phase ? { name: phase.name, objective: phase.objective, opening: phase.opening } : null)}
Domain principles: ${JSON.stringify(specs.domain.principles ?? [])}
Current topic: ${state.current_topic ?? "not established"}
Pending trainer question: ${state.pending_question ?? "none"}
Relevant domain references: ${JSON.stringify(knowledgeHits)}
Complete transcript:\n${transcriptText(transcript)}

Return JSON only:
{
  "learner_intent": "answer" | "question" | "clarification" | "off_topic" | "stop",
  "on_track": true | false,
  "should_grade": true | false,
  "current_topic": "short description of the established topic",
  "response_instruction": "how the next response should preserve or recover direction"
}
A request to repeat, slow down, confirm audio, or clarify the trainer's wording is not gradeable.
A relevant requirements question may be gradeable when the active phase assesses clarification skills.`;

  try {
    const parsed = JSON.parse(await callOpenRouter("direction", [
      { role: "system", content: "You are a strict interview conversation controller. Output valid JSON only." },
      { role: "user", content: prompt },
    ], true)) as DirectionCheck;
    const validIntents = new Set(["answer", "question", "clarification", "off_topic", "stop"]);
    if (
      !validIntents.has(parsed.learner_intent) ||
      typeof parsed.on_track !== "boolean" ||
      typeof parsed.should_grade !== "boolean" ||
      typeof parsed.current_topic !== "string" ||
      typeof parsed.response_instruction !== "string"
    ) {
      throw new Error("Invalid direction response");
    }
    return parsed;
  } catch (error) {
    console.warn("[interview-runtime] direction check failed", error);
    return {
      learner_intent: "answer",
      on_track: true,
      should_grade: true,
      current_topic: state.current_topic ?? "",
      response_instruction: "Continue the current interview thread.",
    };
  }
}

async function runAnalyzerLLM(
  learnerText: string,
  transcript: TranscriptTurn[],
  direction: DirectionCheck,
  specs: CompiledSpecs,
  state: RuntimeState,
  knowledgeHits: KnowledgeHit[]
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
Reference material from knowledge base: ${JSON.stringify(knowledgeHits.slice(0, 5))}
Conversation direction check: ${JSON.stringify(direction)}
Pending trainer question: ${state.pending_question ?? "none"}
Current runtime state: ${JSON.stringify(state)}
Complete transcript:
${transcriptText(transcript)}

Learner's latest answer:
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
      "analysis",
      [
        { role: "system", content: "You are an expert technical interviewer evaluator. Output strictly valid JSON." },
        { role: "user", content: prompt },
      ],
      true
    );

    const parsed = JSON.parse(rawJson) as AnswerAnalysis;
    const { applied } = validateAnalysis(parsed, specs.agent, state, learnerText);
    if (
      (applied.classification === "strong" || applied.classification === "partial") &&
      applied.evidence_updates.length === 0
    ) {
      applied.classification = "vague";
    }
    return applied;
  } catch (error) {
    console.warn("[interview-runtime] answer analysis failed", error);
    return {
      classification: "unknown",
      learner_intent: direction.learner_intent === "question" ? "question" : "answer",
      valid_evidence: [],
      evidence_updates: [],
      claim_assessments: [],
      unresolved_point: "",
      unresolved_evidence_key: null,
    };
  }
}

function clip(text: string, max = 300): string {
  return text.trim().slice(0, max);
}

function learnerStateFrom(
  direction: DirectionCheck,
  analysis?: AnswerAnalysis | null
): string {
  if (direction.learner_intent === "stop") return "stop";
  if (!direction.should_grade || direction.learner_intent === "clarification") return "confused";
  switch (analysis?.classification) {
    case "strong":
      return "strong";
    case "partial":
      return "partial";
    case "vague":
    case "unsupported":
      return "vague";
    case "contradictory":
      return "off_track";
    default:
      return "confused";
  }
}

async function generateContentSpeech(
  action: InterviewAction,
  specs: CompiledSpecs,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  direction: DirectionCheck,
  knowledgeHits: KnowledgeHit[],
  priorErrors: string[] = []
): Promise<string> {
  const phase = specs.agent.phases[state.phase_index] ?? null;
  const rules = renderRules(specs.agent, state);
  const prompt = `Generate the next interviewer utterance for the selected action.
Preserve the current conversation thread and do not apply any named persona style yet.
Agent objective: ${specs.agent.objective}
Active phase: ${JSON.stringify(phase)}
Domain principles: ${JSON.stringify(specs.domain.principles ?? [])}
Direction check: ${JSON.stringify(direction)}
Action: ${JSON.stringify(action)}
Current topic: ${state.current_topic ?? "not established"}
Pending trainer question: ${state.pending_question ?? "none"}
Relevant knowledge: ${JSON.stringify(knowledgeHits)}
Complete transcript:
${transcriptText(transcript)}
${priorErrors.length ? `The prior draft failed validation: ${JSON.stringify(priorErrors)}. Fix only those issues.` : ""}

Rules:
- Use only claims and topics present in the transcript, specs, or retrieved knowledge.
- Never say "you mentioned" unless the learner actually mentioned that point.
- Stay on the pending topic unless the direction check explicitly requires a transition.
- If asked to repeat or slow down, restate the pending question more clearly without changing its meaning.
- Ask at most ${rules.maximum_question_marks} question and use at most ${rules.maximum_words} words.
- Never expose internal evidence keys.
- Do not stack multiple asks in one utterance.`;

  try {
    const text = await callOpenRouter("response", [
      { role: "system", content: "You generate precise, context-grounded interview responses." },
      { role: "user", content: prompt },
    ]);
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    const errors = validateRendered(cleaned, action, specs.agent, state);
    if (!errors.length) return cleaned;
    console.warn("[interview-runtime] response validation failed", { errors });
    if (!priorErrors.length) {
      return generateContentSpeech(action, specs, state, transcript, direction, knowledgeHits, errors);
    }
  } catch (error) {
    console.warn("[interview-runtime] response generation failed", error);
  }
  return deterministicFallback(action, specs.agent, state);
}

async function retrievePersonaMoments(
  orgId: string,
  personaId: string,
  action: InterviewAction,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  learnerState: string,
  enabled = true
): Promise<PersonaMoment[]> {
  if (!enabled) return [];
  try {
    const lastLearner = [...transcript].reverse().find((turn) => turn.role === "user")?.text ?? "";
    const query = [
      `learner_state: ${learnerState}`,
      `action: ${action.name}`,
      "move: probe",
      `pending_question: ${clip(state.pending_question ?? "")}`,
      `last_learner: ${clip(lastLearner)}`,
    ].join("\n");
    const hits = await MainCollectionService.searchPersonaVoice(orgId, query, {
      personaId,
      action: action.name,
      learnerState,
      limit: 6,
    });
    console.info("[interview-runtime] persona moments retrieved", {
      hits: hits.length,
      ids: hits.map((hit) => hit.id),
    });
    return hits;
  } catch (error) {
    console.warn("[interview-runtime] persona retrieval failed", error);
    return [];
  }
}

function interviewerLine(text: string): string {
  const match = text.match(/Interviewer:\s*([\s\S]+)/i);
  return (match?.[1] ?? text).trim();
}

async function renderPersonaSpeech(
  contentContract: string,
  action: InterviewAction,
  specs: CompiledSpecs,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  personaMoments: PersonaMoment[],
  priorErrors: string[] = []
): Promise<string> {
  const persona = specs.persona;
  const examples = persona.examples?.[action.name] ?? persona.examples?.general ?? [];
  const shots = personaMoments.map((moment) => interviewerLine(moment.text)).filter(Boolean).slice(0, 6);
  const exampleShots = examples.slice(0, 3);
  const wordLimit = Math.max(renderRules(specs.agent, state).maximum_words, 90);
  const system = `You are ${persona.name} running this interview out loud. Speak like the interviewer lines below, not like ChatGPT or a corporate coach.

HOW ${persona.name.toUpperCase()} TALKS (copy rhythm, fillers, length; do not copy names, companies, or facts):
${(shots.length ? shots : exampleShots).map((line) => `Interviewer: ${line}`).join("\n\n") || "(no retrieved lines)"}

BAD (do not sound like this): "That's helpful. Can you clarify the daily active user count?"
GOOD: match the interviewer lines — short acknowledgements like "got it, got it" / "correct?" / "good, good", restate the learner's last point, then one poke.

Content contract — keep this topic and the one real ask, change the wording freely:
${contentContract}

Rules:
- One real question. Extra "correct?" / "okay?" backchannels are fine.
- About 30-80 words, never more than ${wordLimit}.
- Do not copy people, projects, or metrics from the interviewer lines.
- Do not say "you mentioned" unless those words are in the learner transcript.
- Never expose internal evidence keys or phrases like "in your own words" for snake_case labels.
${priorErrors.length ? `Fix these issues only: ${JSON.stringify(priorErrors)}` : ""}`;
  const prompt = `Action: ${action.name}
Intent: ${action.intent}
Latest learner turn: ${[...transcript].reverse().find((turn) => turn.role === "user")?.text ?? "(none)"}
Transcript:
${transcriptText(transcript)}

Speak the next interviewer turn now. Return only the spoken text.`;

  try {
    const text = await callOpenRouter("persona", [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ]);
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    const errors = validatePersonaRewrite(
      cleaned,
      contentContract,
      action,
      specs.agent,
      state,
      transcript,
      personaMoments.map((moment) => moment.text),
      specs.agent.scenario
    );
    if (!errors.length) return cleaned;
    console.warn("[interview-runtime] persona validation failed", { errors });
    if (!priorErrors.length) {
      return renderPersonaSpeech(contentContract, action, specs, state, transcript, personaMoments, errors);
    }
  } catch (error) {
    console.warn("[interview-runtime] persona rendering failed", error);
  }
  return deterministicFallback(action, specs.agent, state);
}

function spokenContentContract(
  action: InterviewAction,
  state: RuntimeState,
  transcript: TranscriptTurn[]
): string {
  const lastLearner = [...transcript].reverse().find((turn) => turn.role === "user")?.text ?? "";
  return [
    state.current_topic ? `Topic: ${state.current_topic}` : "",
    lastLearner ? `Learner just said: ${clip(lastLearner, 220)}` : "",
    `Ask one spoken question about ${evidenceLabel(action.evidence_key)}.`,
  ].filter(Boolean).join("\n");
}

async function generatePipelineSpeech(
  action: InterviewAction,
  specs: CompiledSpecs,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  direction: DirectionCheck,
  knowledgeHits: KnowledgeHit[],
  moments: PersonaMoment[]
): Promise<string> {
  if (isRepeatRequest(direction) && action.fallback_text) return action.fallback_text;
  const contentContract = moments.length
    ? spokenContentContract(action, state, transcript)
    : await generateContentSpeech(action, specs, state, transcript, direction, knowledgeHits);
  return renderPersonaSpeech(contentContract, action, specs, state, transcript, moments);
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

  const { messages = [], stream = true, tools = [] } = body;
  const model = "trainertwin-runtime";
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
  const personaVoiceAvailable = configSnapshot.personaVoiceAvailable !== false;

  // Load or init state
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

  // Determine turn type
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
      const openingAction: InterviewAction = {
        name: "opening",
        evidence_key: specs.agent.phases[0]?.evidence_keys[0] ?? null,
        reason: "Start the configured interview.",
        intent: specs.agent.phases[0]?.opening ?? specs.agent.objective,
        close: false,
        expects_answer: true,
      };
      const baseOpening = specs.agent.opening || "Welcome to the interview session. Let's begin.";
      const personaMoments = await retrievePersonaMoments(
        session.orgId,
        specs.persona.id,
        openingAction,
        state,
        currentTranscript,
        "strong",
        personaVoiceAvailable
      );
      const openingText = await renderPersonaSpeech(
        baseOpening,
        openingAction,
        specs,
        state,
        currentTranscript,
        personaMoments
      );
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
    // Tool result reducer without re-grading
    let replyText = "Thank you. Let's proceed.";
    if (state.learner_turns === 0 && !state.actions.includes("opening")) {
      const openingAction: InterviewAction = {
        name: "opening",
        evidence_key: specs.agent.phases[0]?.evidence_keys[0] ?? null,
        reason: "Start the configured interview after preparing its surface.",
        intent: specs.agent.phases[0]?.opening ?? specs.agent.objective,
        close: false,
        expects_answer: true,
      };
      const baseOpening = specs.agent.opening || "Welcome to the interview session. Let's begin.";
      const personaMoments = await retrievePersonaMoments(
        session.orgId,
        specs.persona.id,
        openingAction,
        state,
        currentTranscript,
        "strong",
        personaVoiceAvailable
      );
      replyText = await renderPersonaSpeech(
        baseOpening,
        openingAction,
        specs,
        state,
        currentTranscript,
        personaMoments
      );
      state.actions.push("opening");
      recordAskedQuestion(state, openingAction, replyText);
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
    const latestUserText = String(userMessages[userMessages.length - 1]?.content ?? "");
    turnUserText = latestUserText;
    const fullTranscript = [...currentTranscript, { role: "user" as const, text: latestUserText }];
    const knowledgeHits = await retrieveKnowledge(
      specs.knowledgeBases,
      `${transcriptText(fullTranscript)}\nActive objective: ${specs.agent.phases[state.phase_index]?.objective ?? specs.agent.objective}`,
      session.orgId
    );
    const direction = await runDirectionCheck(latestUserText, fullTranscript, specs, state, knowledgeHits);
    state.latest_learner_intent = direction.learner_intent;

    let action: InterviewAction;
    let analysis: AnswerAnalysis | null = null;
    if (direction.learner_intent === "stop") {
      action = closingAction(state, specs.agent);
    } else if (!direction.should_grade) {
      const pendingEvidence = state.pending_evidence_key ?? specs.agent.phases[state.phase_index]?.evidence_keys[0] ?? null;
      const repeat = isRepeatRequest(direction);
      action = {
        name: specs.agent.phases[state.phase_index]?.default_action ?? specs.agent.default_action,
        evidence_key: pendingEvidence,
        reason: direction.response_instruction,
        intent: repeat
          ? direction.response_instruction
          : `The learner already responded or wants to continue. Do not repeat the previous question. Ask exactly one new question to establish ${pendingEvidence}. ${specs.agent.phases[state.phase_index]?.opening ?? ""}`,
        fallback_text: repeat ? (state.pending_question ?? specs.agent.opening) : undefined,
        close: false,
        expects_answer: true,
      };
    } else {
      state.learner_turns += 1;
      state.phase_turns += 1;
      analysis = await runAnalyzerLLM(
        latestUserText,
        fullTranscript,
        direction,
        specs,
        state,
        knowledgeHits
      );
      action = selectAction(analysis, state, specs.persona, specs.agent);
    }
    const learnerState = learnerStateFrom(direction, analysis);
    const personaMoments = await retrievePersonaMoments(
      session.orgId,
      specs.persona.id,
      action,
      state,
      fullTranscript,
      learnerState,
      personaVoiceAvailable
    );
    const controllerAction = action.name;
    action = applyPersonaVote(
      action,
      activeAllowedActions(specs.agent, state),
      personaMoments.map((moment) => moment.action ?? ""),
      state.actions
    );
    console.info("[interview-runtime] persona vote", {
      controllerAction,
      votedAction: action.name,
      momentIds: personaMoments.map((moment) => moment.id),
    });
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
        const spokenText = await generatePipelineSpeech(
          action,
          specs,
          state,
          fullTranscript,
          direction,
          knowledgeHits,
          personaMoments
        );
        recordAskedQuestion(state, action, spokenText, direction.should_grade);
        if (direction.should_grade) refreshCurrentTopic(state, spokenText, latestUserText);
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
      const spokenText = await generatePipelineSpeech(
        action,
        specs,
        state,
        fullTranscript,
        direction,
        knowledgeHits,
        personaMoments
      );
      recordAskedQuestion(state, action, spokenText, direction.should_grade);
      if (direction.should_grade) refreshCurrentTopic(state, spokenText, latestUserText);
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

  // Update the canonical persisted transcript.
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
