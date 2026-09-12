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
  type CorpusStyleStats,
  type InterviewAction,
  type RuntimeState,
  RENDERER_RULES,
  closingAction,
  compareStyleRates,
  currentSessionStyle,
  deterministicFallback,
  evidenceLabel,
  extractLearnerName,
  flagsFromCompliance,
  initRuntimeState,
  mechanicalSpeechFlags,
  recordAskedQuestion,
  refreshCurrentTopic,
  rendererBounds,
  selectAction,
  spokenWordLimit,
  styleFilterDecisions,
  surfaceForPhase,
  validateAnalysis,
  wordCount,
} from "./runtime";

const OPENROUTER_BASE_URL = env.OPENROUTER_BASE_URL.replace(/\/$/, "");
const RUNTIME_MODEL = env.INTERVIEW_LLM_MODEL;

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Per-request usage accumulator. OpenRouter reports usage per non-stream call;
 * the runtime sums it across pipeline stages (direction, analysis, speech,
 * persona) and emits one usage chunk in the final SSE frame (LiveKit's
 * inference LLMStream parses any chunk with `usage` as the usage event).
 */
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
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  stream?: boolean;
}

type TranscriptTurn = { role: "user" | "trainer"; text: string };
type KnowledgeHit = { id: string; docId: string; source: string; text: string; score: number };
type PersonaRecordHit = {
  id: string;
  sourceId: string;
  text: string;
  score: number;
  sessionPhase?: string;
  pastLearnerName?: string;
  usesLearnerName?: boolean;
  startsWithThanks?: boolean;
  hasDoubledAcknowledgement?: boolean;
};
type PersonaPrimer = { statistics: CorpusStyleStats };

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
  responseFormatJson = false,
  usage?: UsageSink
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
  const durationMs = Math.round(performance.now() - startedAt);

  if (!res.ok) {
    usage?.add(stage, durationMs, null);
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  usage?.add(stage, durationMs, data?.usage);
  console.info(`[interview-runtime] ${stage} completed`, {
    model: RUNTIME_MODEL,
    durationMs,
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
  knowledgeHits: KnowledgeHit[],
  usage?: UsageSink
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
    ], true, usage)) as DirectionCheck;
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
  knowledgeHits: KnowledgeHit[],
  usage?: UsageSink
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
      true,
      usage
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

/**
 * Mechanical session phase: opening before any learner turn, closing once the
 * session is wrapping, middle otherwise. The observer LLM is not asked for this
 * — it is a fact of the runtime state.
 */
function sessionPhaseOf(state: RuntimeState, action: InterviewAction): "opening" | "middle" | "closing" {
  if (state.learner_turns === 0 && !state.actions.includes("opening")) return "opening";
  if (action.close || state.end_reason === "completed") return "closing";
  return "middle";
}

async function retrieveAnalogousEpisodes(
  orgId: string,
  personaId: string,
  action: InterviewAction,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  learnerState: string,
  enabled = true
): Promise<PersonaRecordHit[]> {
  if (!enabled) return [];
  try {
    const lastLearner = [...transcript].reverse().find((turn) => turn.role === "user")?.text ?? "";
    const query = [
      `Session phase: ${sessionPhaseOf(state, action)}`,
      `Learner situation: ${clip(lastLearner, 600)}`,
      state.pending_question ? `Pending trainer question: ${clip(state.pending_question, 200)}` : "",
      `Learner state: ${learnerState}`,
    ].filter(Boolean).join("\n");
    const hits = (await MainCollectionService.searchPersonaEpisodes(orgId, query, {
      personaId,
      sessionPhase: sessionPhaseOf(state, action),
      limit: 3,
      diversify: true,
    })) as PersonaRecordHit[];
    console.info("[interview-runtime] analogous episodes retrieved", {
      hits: hits.length,
      ids: hits.map((hit) => hit.id),
    });
    return hits;
  } catch (error) {
    console.warn("[interview-runtime] episode retrieval failed", error);
    return [];
  }
}

export interface SpeechMeta {
  attempts: number;
  flags: string[];
  fallback: boolean;
  rendererFallback: boolean;
  draftWords: number;
  finalWords: number;
}

/**
 * Content stage: decides WHAT to say. It deliberately receives no persona
 * style examples and no persona voice instructions — style is applied after
 * the draft exists (plans/issues_persona-validation-loop.md §17).
 */
async function contentDraft(
  contentContract: string,
  action: InterviewAction,
  specs: CompiledSpecs,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  direction: DirectionCheck | null,
  knowledgeHits: KnowledgeHit[],
  episodes: PersonaRecordHit[],
  usage?: UsageSink
): Promise<string> {
  const persona = specs.persona;
  const phase = specs.agent.phases[state.phase_index] ?? null;
  const wordLimit = spokenWordLimit(specs.agent, state);
  const system = `You are ${persona.name} preparing the CONTENT of the next spoken trainer response in a live interview session.
Decide the correct response using the session spec, the conversation observation, and retrieved knowledge. Be concise and conversational: about 30-80 words, never more than ${wordLimit}.
Do not invent facts about the learner or documents. If the session spec refers to a document that is unavailable, adapt naturally and ask the learner to describe the relevant experience verbally.
Keep exactly one clear response purpose and its intended question. A later stage renders the spoken wording, so write content, not style.

SESSION SPEC
Scenario: ${specs.agent.name ?? "interview session"}
Objective: ${specs.agent.objective}
Active phase: ${JSON.stringify(phase ? { name: phase.name, objective: phase.objective, opening: phase.opening } : null)}
Domain principles: ${JSON.stringify(specs.domain.principles ?? [])}
${state.primer ? `Corpus behavior statistics: ${JSON.stringify(state.primer.statistics)}` : ""}
${episodes.length ? `\nPAST CONVERSATION EXAMPLES — different learners, behavior evidence only; never copy names, employers, projects or facts:\n${episodes.map((hit) => hit.text).join("\n---\n")}` : ""}
${knowledgeHits.length ? `\nRelevant knowledge references: ${JSON.stringify(knowledgeHits.slice(0, 3))}` : ""}
${direction ? `\nConversation direction: ${JSON.stringify({ learner_intent: direction.learner_intent, response_instruction: direction.response_instruction })}` : ""}`;

  const prompt = `Action: ${action.name}
Intent: ${action.intent}
${state.pending_question ? `Pending question from earlier: ${state.pending_question}` : ""}
Content contract — keep this topic and the one real ask:
${contentContract}
${direction ? `Direction check: ${JSON.stringify({ learner_intent: direction.learner_intent, response_instruction: direction.response_instruction })}` : ""}
Complete transcript:
${transcriptText(transcript)}

Return only the content draft to speak.`;

  const raw = await callOpenRouter("content", [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ], false, usage);
  return raw.trim().replace(/^["']|["']$/g, "");
}

async function styleGate(
  draft: string,
  learnerText: string,
  action: InterviewAction,
  state: RuntimeState,
  current: ReturnType<typeof currentSessionStyle>,
  usage?: UsageSink
): Promise<string> {
  const prompt = `Latest learner speech: ${learnerText}
Content draft: ${draft}
Current-session style statistics: ${JSON.stringify(current)}

Describe the completed draft's conversational function, learner state, and sentence shape for topic-neutral style retrieval of the trainer's past speech. Do not rewrite the draft. Do not propose phrasing. Return JSON only: {"style_query": "topic-neutral description of the situation, function and learner state for similarity search; no proposed response style"}`;

  const raw = await callOpenRouter("style_gate", [
    { role: "system", content: `You prepare a retrieval query for analogous speaking moments of the trainer. Describe only the current conversational situation, function, and learner state. Do not decide the response, propose phrasing, prescribe cadence, or say whether to use the learner's name or an acknowledgement.` },
    { role: "user", content: prompt },
  ], true, usage);
  try {
    const parsed = JSON.parse(raw) as { style_query?: string; query?: string };
    return (parsed.style_query || parsed.query || "").trim() || `${action.name}; ${draft.slice(0, 200)}`;
  } catch {
    return `${action.name}; ${draft.slice(0, 200)}`;
  }
}

function fingerprint(doc: string): string {
  return doc.replace(/\s+/g, " ").trim().slice(0, 100);
}

async function retrieveStyleExamplesForTurn(
  orgId: string,
  personaId: string,
  styleQuery: string,
  phase: "opening" | "middle" | "closing",
  current: ReturnType<typeof currentSessionStyle>,
  trainerTurnCount: number,
  state: RuntimeState
): Promise<PersonaRecordHit[]> {
  const corpus = state.primer?.statistics ?? null;
  const decisions = styleFilterDecisions(current, corpus, trainerTurnCount);
  const recent = new Set(state.recent_style_docs ?? []);
  const pull = async (filters: { usesLearnerName?: boolean; startsWithThanks?: boolean; hasDoubledAcknowledgement?: boolean } | undefined) =>
    (await MainCollectionService.searchStyleEpisodes(orgId, styleQuery, {
      personaId,
      sessionPhase: phase,
      limit: 5,
      diversify: true,
      ...(filters ? { styleFilters: filters } : {}),
    })) as PersonaRecordHit[];

  let pool = await pull(
    decisions.excludeLearnerName || decisions.excludeThanksStart || decisions.requireDoubledAcknowledgement
      ? {
          ...(decisions.excludeLearnerName ? { usesLearnerName: false } : {}),
          ...(decisions.excludeThanksStart ? { startsWithThanks: false } : {}),
          ...(decisions.requireDoubledAcknowledgement ? { hasDoubledAcknowledgement: true } : {}),
        }
      : undefined
  );
  if (!pool.length) pool = await pull(undefined);

  // Rotation: prefer examples not used in recent turns so no top-k set dominates.
  const fresh = pool.filter((hit) => !recent.has(fingerprint(hit.text)));
  const ordered = [...fresh, ...pool.filter((hit) => recent.has(fingerprint(hit.text)))];
  const chosen = ordered.slice(0, 5);
  for (const hit of chosen) {
    recent.add(fingerprint(hit.text));
  }
  state.recent_style_docs = [...recent].slice(-12);
  return chosen;
}

/**
 * Renderer: one bounded call. Rephrases the completed draft in the persona's
 * wording/rhythm using retrieved style examples. Mechanical bounds (length,
 * question count, invented mentions) plus the model's own reasoning decide
 * between rewrite and draft — no retry loop (Section 17.2).
 */
async function renderStyledSpeech(
  draft: string,
  learnerText: string,
  state: RuntimeState,
  specs: CompiledSpecs,
  styleExamples: PersonaRecordHit[],
  current: ReturnType<typeof currentSessionStyle>,
  usage?: UsageSink
): Promise<{ text: string; flags: string[]; fallback: boolean }> {
  const persona = specs.persona;
  const system = `You are a bounded speech renderer. Rephrase the completed draft in ${persona.name}'s wording and rhythm using the retrieved style examples.
Preserve the draft's meaning, technical facts, correction, uncertainty, response purpose, intended question, and number of focal questions. Do not add names, projects, employers, technologies, or claims from past examples. Do not answer a different question.
Match or shorten the draft's length. Never add a question. Keep the draft's question count.
${state.primer ? `Corpus behavior statistics: ${JSON.stringify(state.primer.statistics)}\nCurrent-session drift: ${JSON.stringify(compareStyleRates(current, state.primer.statistics))}\nCorpus rates describe a whole session, not every turn; vary wording when the current session overuses a form.` : ""}

HOW ${persona.name.toUpperCase()} TALKS (copy rhythm, fillers, phrasing; do not copy names, companies, or facts):
${styleExamples.map((hit) => hit.text).join("\n---\n") || "(no retrieved examples)"}

Return JSON only:
{"reasoning": {"meaning_preserved": {"ok": true, "why": "..."}, "question_preserved": {"ok": true, "why": "..."}, "no_example_fact_copy": {"ok": true, "why": "..."}, "in_vasanth_style": {"ok": true, "why": "..."}}, "spoken_text": "the rephrased response"}`;

  const prompt = `Current learner speech: ${learnerText}
Content draft: ${draft}

Return the rephrased response now.`;

  try {
    const raw = await callOpenRouter("renderer", [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ], true, usage);
    const parsed = JSON.parse(raw) as { reasoning?: unknown; spoken_text?: string };
    const rewrite = String(parsed.spoken_text ?? "").trim().replace(/^["']|["']$/g, "");
    const reasoningFlags = flagsFromCompliance(parsed.reasoning, RENDERER_RULES);
    const boundsFlags = rendererBounds(draft, rewrite);
    const learnerJoined = learnerText;
    const mechanical = mechanicalSpeechFlags(rewrite, learnerJoined, spokenWordLimit(specs.agent, state)).filter(
      (flag) => flag !== "word_budget"
    );
    const fatal = new Set(["empty_response", "length_expansion", "question_count", "no_invented_mention", "meaning_preserved", "question_preserved", "no_example_fact_copy"]);
    const blocking = [...reasoningFlags, ...boundsFlags, ...mechanical].filter((flag) => fatal.has(flag) || flag.endsWith(":missing"));
    if (rewrite && !blocking.length) {
      return { text: rewrite, flags: [...reasoningFlags, ...boundsFlags, ...mechanical], fallback: false };
    }
    console.warn("[interview-runtime] renderer rejected; speaking draft", { flags: blocking });
    return { text: draft, flags: blocking, fallback: true };
  } catch (error) {
    console.warn("[interview-runtime] renderer failed; speaking draft", error);
    return { text: draft, flags: ["renderer_failed"], fallback: true };
  }
}

/**
 * Full speech stage (Section 17): content draft (no style context) → style
 * gate reads the draft → top-5 style retrieval → bounded renderer. When the
 * persona has no episode/style records (not yet reindexed), the draft is
 * spoken as-is — graceful degradation, never a hard failure.
 */
export async function generateSpeech(
  contentContract: string,
  action: InterviewAction,
  specs: CompiledSpecs,
  state: RuntimeState,
  transcript: TranscriptTurn[],
  direction: DirectionCheck | null,
  knowledgeHits: KnowledgeHit[],
  orgId: string,
  personaVoiceAvailable: boolean,
  usage?: UsageSink
): Promise<{ text: string; meta: SpeechMeta }> {
  const trainerTurnTexts = transcript.filter((turn) => turn.role === "trainer").map((turn) => turn.text);
  const current = currentSessionStyle(trainerTurnTexts, state.learner_name ?? null);
  // Learner name is mechanical context (from the learner's own words)
  if (!state.learner_name) {
    state.learner_name = extractLearnerName(transcript.filter((turn) => turn.role === "user").map((turn) => turn.text).join("\n"));
  }
  // Session primer: corpus statistics over the trainer's episode index
  if (personaVoiceAvailable && !state.primer) {
    try {
      const statistics = await MainCollectionService.getPersonaPrimerStats(
        orgId,
        specs.persona.id
      );
      if (statistics.turns > 0) state.primer = { statistics };
    } catch (error) {
      console.warn("[interview-runtime] primer stats unavailable", error);
    }
  }

  const phase = sessionPhaseOf(state, action);
  const episodes = await retrieveAnalogousEpisodes(
    orgId,
    specs.persona.id,
    action,
    state,
    transcript,
    phase === "opening" ? "greeting" : "vague",
    personaVoiceAvailable
  );

  let draft: string;
  try {
    draft = await contentDraft(contentContract, action, specs, state, transcript, direction, knowledgeHits, episodes, usage);
  } catch (error) {
    console.warn("[interview-runtime] content draft failed; deterministic fallback", error);
    return {
      text: deterministicFallback(action, specs.agent, state),
      meta: { attempts: 0, flags: ["fallback"], fallback: true, rendererFallback: false, draftWords: 0, finalWords: 0 },
    };
  }

  let finalText = draft;
  let flags: string[] = [];
  let rendererFallback = false;
  if (personaVoiceAvailable) {
    try {
      const styleQuery = await styleGate(draft, [...transcript].reverse().find((turn) => turn.role === "user")?.text ?? "", action, state, current, usage);
      const examples = await retrieveStyleExamplesForTurn(
        orgId,
        specs.persona.id,
        styleQuery,
        phase,
        current,
        transcript.filter((turn) => turn.role === "trainer").length,
        state
      );
      if (examples.length) {
        const rendered = await renderStyledSpeech(draft, [...transcript].reverse().find((turn) => turn.role === "user")?.text ?? "", state, specs, examples, current, usage);
        finalText = rendered.text;
        flags = rendered.flags;
        rendererFallback = rendered.fallback;
      }
    } catch (error) {
      console.warn("[interview-runtime] style stage failed; speaking draft", error);
    }
  }

  return {
    text: finalText,
    meta: {
      attempts: flags.length ? 2 : 1,
      flags,
      fallback: false,
      rendererFallback,
      draftWords: wordCount(draft),
      finalWords: wordCount(finalText),
    },
  };
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
  orgId: string,
  personaVoiceAvailable: boolean,
  usage?: UsageSink
): Promise<{ text: string; meta: SpeechMeta }> {
  if (isRepeatRequest(direction) && action.fallback_text) {
    return {
      text: action.fallback_text,
      meta: { attempts: 0, flags: [], fallback: false, rendererFallback: false, draftWords: 0, finalWords: 0 },
    };
  }
  const contentContract = spokenContentContract(action, state, transcript);
  return generateSpeech(contentContract, action, specs, state, transcript, direction, knowledgeHits, orgId, personaVoiceAvailable, usage);
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

  // Top-level guard: any unexpected failure (DB, spec compile, …) must surface
  // as an OpenAI-structured error, never Next's default HTML 500.
  try {
    return await runCompletionPipeline(session, body);
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

async function runCompletionPipeline(
  session: NonNullable<Awaited<ReturnType<typeof authorizeRuntimeSession>>>,
  body: ChatCompletionRequest
): Promise<Response> {
  const { messages = [], stream = true, tools = [] } = body;
  const model = "trainertwin-runtime";
  const requestHash = computeRequestHash(session.runtimeTokenHash + session.id, messages);

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
  let turnSpeechMeta: SpeechMeta | null = null;

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
      const opening = await generateSpeech(
        baseOpening,
        openingAction,
        specs,
        state,
        currentTranscript,
        null,
        [],
        session.orgId,
        personaVoiceAvailable,
        usageSink
      );
      const openingText = opening.text;
      turnSpeechMeta = opening.meta;
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
      const opening = await generateSpeech(
        baseOpening,
        openingAction,
        specs,
        state,
        currentTranscript,
        null,
        [],
        session.orgId,
        personaVoiceAvailable,
        usageSink
      );
      replyText = opening.text;
      turnSpeechMeta = opening.meta;
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
    const direction = await runDirectionCheck(latestUserText, fullTranscript, specs, state, knowledgeHits, usageSink);
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
        knowledgeHits,
        usageSink
      );
      action = selectAction(analysis, state, specs.persona, specs.agent);
    }
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
        const spoken = await generatePipelineSpeech(
          action,
          specs,
          state,
          fullTranscript,
          direction,
          knowledgeHits,
          session.orgId,
          personaVoiceAvailable,
          usageSink
        );
        const spokenText = spoken.text;
        turnSpeechMeta = spoken.meta;
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
      const spoken = await generatePipelineSpeech(
        action,
        specs,
        state,
        fullTranscript,
        direction,
        knowledgeHits,
        session.orgId,
        personaVoiceAvailable,
        usageSink
      );
      const spokenText = spoken.text;
      turnSpeechMeta = spoken.meta;
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

  // Final usage chunk: LiveKit's inference LLMStream treats any chunk with a
  // `usage` field as the usage event. Always emitted (zeros when all LLM
  // stages failed), so the contract is deterministic for clients.
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

  // Aggregate telemetry for the whole completion
  console.info("[interview-runtime] completion served", {
    sessionId: session.id,
    revision: (session.runtimeRevision ?? 0) + 1,
    turn: isOpeningTurn ? "opening" : isToolResponseTurn ? "tool_result" : "learner",
    latencyMs: Math.round(performance.now() - startedAt),
    promptTokens: usageTotals.prompt_tokens,
    completionTokens: usageTotals.completion_tokens,
    totalTokens: usageTotals.total_tokens,
    stages: usageSink.stages.map((s) => `${s.stage}:${s.ms}ms`),
    speech: turnSpeechMeta ?? { attempts: 0, flags: [], fallback: false },
  });

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
