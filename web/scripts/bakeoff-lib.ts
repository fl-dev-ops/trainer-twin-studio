/**
 * Speech/turn-strategy bake-off.
 *
 * Runs 11 turn-generation strategies (V2 current baseline + A..J hybrids) over
 * 6 scenarios against the real OpenRouter model, judges every response with a
 * fixed rubric, and prints a comparison table.
 *
 * Run: bun run scripts/strategy-bakeoff.ts [strategyKeys...] [scenarioIndices...]
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { buildSpecs, type CompiledSpecs } from "../lib/runtime/compiler";
import {
  type InterviewAction,
  type RuntimeState,
  initRuntimeState,
  recordAskedQuestion,
  selectAction,
  spokenWordLimit,
} from "../lib/runtime/runtime";
import { env } from "../env";

export { initRuntimeState, midSessionState, PENDING_Q, PENDING_EVIDENCE };

// DATA_DIR lives in runner = path.resolve(process.cwd(), "data");
export const RUNTIME_MODEL = env.INTERVIEW_LLM_MODEL;
export const SMALL_MODEL = "openai/gpt-4.1-nano";

// Shared core for the strategy bake-offs.
// ---------- fixtures ----------

export function loadConfig(agentSlug = "resume-defense", personaSlug = "vasanth") {
  const agentYaml = fs.readFileSync(path.join(DATA(), `agents/${agentSlug}.yaml`), "utf8");
  const personaYaml = fs.readFileSync(path.join(DATA(), `personas/${personaSlug}.yaml`), "utf8");
  const agentData = (yaml.load(agentYaml) as any).agent;
  const personaData = (yaml.load(personaYaml) as any).persona;
  const domainData = (yaml.load(fs.readFileSync(path.join(DATA(), `domains/${agentData.domain}.yaml`), "utf8")) as any).domain;
  return {
    persona: { version: personaData.version ?? 1, data: personaData },
    agent: { version: agentData.version ?? 1, data: agentData },
    domain: { version: domainData.version ?? 1, data: domainData },
    knowledgeBases: [],
  };
}
export function DATA() { return path.resolve(process.cwd(), "data"); }

export type Turn = { role: "trainer" | "learner"; text: string };
export type Scenario = { name: string; prior: Turn[]; learner: string; pendingQuestion?: string; pendingEvidence?: string };

export const SPECS: CompiledSpecs = buildSpecs(loadConfig());

const PENDING_Q = "Which exact component of the payments service did you personally implement?";
const PENDING_EVIDENCE = "defense_ownership";

function midSessionState(): RuntimeState {
  const state = initRuntimeState();
  recordAskedQuestion(state, {
    name: "ask_exact_example",
    evidence_key: PENDING_EVIDENCE,
    reason: "bakeoff fixture",
    intent: "ask question",
    close: false,
    expects_answer: true,
  } as InterviewAction, PENDING_Q, true);
  return state;
}

// ---------- llm ----------

export type CallRecord = { stage: string; ms: number; background?: boolean };
export type Metrics = { calls: CallRecord[]; criticalCalls: number; criticalMs: number; backgroundMs: number; wallMs: number };

export function metrics(): Metrics {
  return { calls: [], criticalCalls: 0, criticalMs: 0, backgroundMs: 0, wallMs: 0 };
}

export async function llm(
  m: Metrics,
  stage: string,
  messages: { role: string; content: string }[],
  opts: { json?: boolean; model?: string; background?: boolean; temperature?: number } = {}
): Promise<string> {
  const started = performance.now();
  const res = await fetch(`${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model ?? RUNTIME_MODEL,
      messages,
      temperature: opts.temperature ?? (opts.json ? 0 : 0.4),
      max_tokens: opts.json ? 1200 : 400,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Math.round(performance.now() - started);
  m.calls.push({ stage, ms, background: opts.background });
  if (opts.background) m.backgroundMs += ms;
  else { m.criticalCalls += 1; m.criticalMs += ms; }
  if (!res.ok) throw new Error(`${stage} failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

export const transcriptText = (turns: Turn[]) => turns.map((t) => `${t.role === "trainer" ? "Trainer" : "Learner"}: ${t.text}`).join("\n");

// ---------- shared prompt fragments ----------

export const persona = SPECS.persona as { name: string; style?: { tone?: string; habits?: string[]; avoid?: string[] }; examples?: Record<string, string[]> };
export const PERSONA_VOICE = `You are ${persona.name}, an experienced technical interviewer.
Tone: ${persona.style?.tone ?? "professional"}
Habits: ${(persona.style?.habits ?? []).join("; ")}
Avoid: ${(persona.style?.avoid ?? []).join("; ")}
Voice examples (rhythm only, never copy facts/names):
${((Object.values(persona.examples ?? {}) ?? []) as string[][]).flat().slice(0, 8).map((l) => `Interviewer: ${l}`).join("\n")}`;

export const AGENT_CONTEXT = `Agent objective: ${SPECS.agent.objective}
Active phase: ${JSON.stringify(SPECS.agent.phases[0] ? { name: SPECS.agent.phases[0].name, objective: SPECS.agent.phases[0].objective, evidence_keys: SPECS.agent.phases[0].evidence_keys } : null)}
Session context: NO resume or document was uploaded for this session. Never claim access to a document; if asked, say so and ask the candidate to describe their work verbally.`;

export const RULES_FREE = `Rules:
- At most one real question. Backchannels ("correct?", "yeah?") are not asks. Some turns contain NO ask at all — answering and yielding is legal.
- Speak only from the transcript, the agent context, or what the learner said. Never invent people, projects, or metrics.
- Never say "you mentioned X" unless X is verbatim in the learner's words.
- Match ${persona.name}'s rhythm. No generic praise ("that's solid"), no role reversal ("I built...").
- Spoken word ceiling: ${spokenWordLimit(SPECS.agent, initRuntimeState())} words.`;

// ---------- strategies ----------

export type Ctx = { scenario: Scenario; state: RuntimeState; learner: string; history: Turn[]; moments: { text: string }[]; retrieve?: (query: string, limit?: number) => Promise<{ text: string }[]> };
export type StrategyResult = { text: string; m: Metrics; decision?: unknown };
type Strategy = (ctx: Ctx, m: Metrics) => Promise<StrategyResult>;

export function voiceMomentsBlock(moments: { text: string }[]): string {
  const lines = moments.map((mo) => `Interviewer: ${(mo.text.match(/Interviewer:\s*([\s\S]+)/i)?.[1] ?? mo.text).trim()}`).filter(Boolean).slice(0, 6);
  return `Voice moments retrieved for this turn (rhythm only — never copy facts/names):\n${lines.join("\n\n") || "(none retrieved)"}`;
}

const decisionIntro = (ctx: Ctx) => `${AGENT_CONTEXT}
Transcript so far:
${transcriptText(ctx.scenario.prior) || "(empty — session not opened yet)"}
Pending trainer question: ${ctx.scenario.pendingQuestion ?? "none"}
Latest learner turn: ${ctx.learner || "(no learner turn — opening)"}`;

// --- V2 current (baseline): direction + analyzer + selectAction + forced-contract speech
async function strategyV2(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const directionRaw = await llm(m, "direction", [
    { role: "system", content: `Check whether the conversation is following the active interview direction.\n${AGENT_CONTEXT}\nPending trainer question: ${ctx.scenario.pendingQuestion ?? "none"}\nComplete transcript:\n${transcriptText(ctx.scenario.prior)}\nLatest learner turn: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Return JSON only: {"learner_intent":"answer|question|clarification|off_topic|stop","on_track":true,"should_grade":true,"current_topic":"...","response_instruction":"..."}` },
  ], { json: true });
  const direction = JSON.parse(directionRaw);

  let analysis: any = { classification: "unknown" };
  if (direction.should_grade) {
    analysis = JSON.parse(await llm(m, "analyzer", [
      { role: "system", content: `Grade the learner's answer.\n${AGENT_CONTEXT}\nEvidence keys: ${JSON.stringify(SPECS.agent.phases[0]?.evidence_keys)}` },
      { role: "user", content: `Latest learner turn: ${ctx.learner}\nReturn JSON only: {"classification":"strong|partial|vague|unsupported|contradictory","topics":[],"learner_state":"..."}` },
    ], { json: true }));
  }

  const action = selectAction(analysis, ctx.state, SPECS.persona, SPECS.agent);
  const contract = [
    ctx.state.current_topic ? `Topic: ${ctx.state.current_topic}` : "",
    ctx.learner ? `Learner just said: ${ctx.learner.slice(0, 220)}` : "",
    `Ask one spoken question about ${action.evidence_key}.`,
  ].filter(Boolean).join("\n");

  const text = await speechCall(m, "speech", contract, ctx);
  return { text, m, decision: { intent: direction.learner_intent, action: action.name } };
}

// --- A: generate → validate → persona rephrase
async function strategyA(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const draft = await llm(m, "generate", [
    { role: "system", content: `You are running a live voice interview. Respond naturally to the learner.\n${AGENT_CONTEXT}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nPending question: ${ctx.scenario.pendingQuestion ?? "none"}\nLatest learner turn: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Write the next interviewer utterance. Return only the spoken text.` },
  ]);
  const validation = await llm(m, "validate", [
    { role: "system", content: `Check the response against the agent spec and domain.\n${AGENT_CONTEXT}\nReturn JSON only: {"aligned":true|false,"problems":["..."]}` },
    { role: "user", content: `Response: ${draft}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nLearner turn: ${ctx.learner}` },
  ], { json: true });
  const v = JSON.parse(validation);
  const text = await llm(m, "rephrase", [
    { role: "system", content: `${PERSONA_VOICE}\nRewrite the response below in your voice. Keep every fact and the same intent. Fix these problems only: ${JSON.stringify(v.problems ?? [])}\nReturn only the spoken text.` },
    { role: "user", content: draft },
  ]);
  return { text, m };
}

// --- B: decide → generate → persona rewrite
async function strategyB(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const decision = await llm(m, "decide", [
    { role: "system", content: `You are the interview director. Choose the next conversational intent.\n${AGENT_CONTEXT}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nPending question: ${ctx.scenario.pendingQuestion ?? "none"}\nLatest learner turn: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Return JSON only: {"intent":"probe|deepen|redirect|answer_meta|transition|acknowledge","evidence_key":"...","instruction":"what this utterance is for, one sentence"}` },
  ], { json: true });
  const d = JSON.parse(decision);
  const draft = await llm(m, "generate", [
    { role: "system", content: `${AGENT_CONTEXT}\nWrite the next interviewer utterance for this intent: ${JSON.stringify(d)}\nUse the transcript and learner turn:\n${transcriptText(ctx.scenario.prior)}\nLearner: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Return only the spoken text.` },
  ]);
  const text = await llm(m, "rephrase", [
    { role: "system", content: `${PERSONA_VOICE}\nRewrite in your voice, same content and intent. Return only the spoken text.` },
    { role: "user", content: draft },
  ]);
  return { text, m, decision: d };
}

// --- C: generate → validate loop → persona rephrase
async function strategyC(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  let draft = await llm(m, "generate", [
    { role: "system", content: `You are running a live voice interview. Respond naturally.\n${AGENT_CONTEXT}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nPending question: ${ctx.scenario.pendingQuestion ?? "none"}\nLearner turn: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Return only the spoken text.` },
  ]);
  for (let i = 0; i < 1; i++) {
    const v = JSON.parse(await llm(m, "validate", [
      { role: "system", content: `Validate against the agent spec and persona expectations (voice, grounded, appropriate).\n${AGENT_CONTEXT}\n${PERSONA_VOICE}\nReturn JSON only: {"ok":true|false,"feedback":"..."}` },
      { role: "user", content: `Response: ${draft}\nLearner turn: ${ctx.learner}` },
    ], { json: true }));
    if (v.ok) break;
    draft = await llm(m, "regenerate", [
      { role: "system", content: `Fix this response. Feedback: ${JSON.stringify(v.feedback)}\nReturn only the spoken text.` },
      { role: "user", content: draft },
    ]);
  }
  const text = await llm(m, "rephrase", [
    { role: "system", content: `${PERSONA_VOICE}\nRewrite in your voice, same content. Return only the spoken text.` },
    { role: "user", content: draft },
  ]);
  return { text, m };
}

// --- D: router fork (direction → heavy vs direct path)
async function strategyD(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const directionRaw = await llm(m, "direction", [
    { role: "system", content: `Classify the learner's turn and say what the response requires.\n${AGENT_CONTEXT}\nPending question: ${ctx.scenario.pendingQuestion ?? "none"}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nLearner turn: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Return JSON only: {"learner_intent":"answer|question|clarification|off_topic|stop","needs_deliberation":true|false,"response_instruction":"what this response is for"}` },
  ], { json: true });
  const d = JSON.parse(directionRaw);
  if (d.needs_deliberation) {
    const decision = await llm(m, "decide", [
      { role: "system", content: `Choose the next move for this answer.\n${AGENT_CONTEXT}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nLearner: ${ctx.learner}` },
      { role: "user", content: `Return JSON only: {"evidence_key":"...","instruction":"what this utterance is for"}` },
    ], { json: true });
    const text = await speechCall(m, "speech", JSON.parse(decision).instruction, ctx);
    return { text, m, decision: { path: "deliberate", intent: d.learner_intent } };
  }
  const text = await speechCall(m, "speech", d.response_instruction, ctx);
  return { text, m, decision: { path: "direct", intent: d.learner_intent } };
}

// --- E: all-in-one self-check call
async function strategyE(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const raw = await llm(m, "one_call", [
    { role: "system", content: `${PERSONA_VOICE}\n\nYou are running this session out loud. Decide what this turn is for, then speak.\n${voiceMomentsBlock(ctx.moments)}\n${AGENT_CONTEXT}\nPending question: ${ctx.scenario.pendingQuestion ?? "none"}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nLearner turn: ${ctx.learner || "(no learner turn — opening)"}` },
    { role: "user", content: `Reason against each rule, then speak. Return JSON only:\n{"turn_intent":"answer_learner|probe|deepen|transition|greet_open","reasoning":{"one_real_question":{"ok":true,"why":"..."},"grounded":{"ok":true,"why":"..."},"in_persona_voice":{"ok":true,"why":"..."}},"spoken_text":"..."}` },
  ], { json: true });
  const parsed = JSON.parse(raw) as { spoken_text?: string; turn_intent?: string };
  return { text: String(parsed.spoken_text ?? "").trim(), m, decision: parsed.turn_intent };
}

// --- F: speak now, ledger async (critical path = E; analyzer in background)
async function strategyF(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const e = await strategyE(ctx, m);
  await llm(m, "analyze_bg", [
    { role: "system", content: `Grade the learner's answer against the evidence keys (background work, not on the audio path).\n${AGENT_CONTEXT}` },
    { role: "user", content: `Learner: ${ctx.learner}\nReturn JSON only: {"classification":"strong|partial|vague|unsupported|contradictory"}` },
  ], { json: true, background: true });
  return { ...e, decision: { ...(e.decision as object), background: "ledger update off critical path" } };
}

// --- G: two parallel drafts + judge merge
async function strategyG(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const base = `${AGENT_CONTEXT}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nPending question: ${ctx.scenario.pendingQuestion ?? "none"}\nLearner turn: ${ctx.learner || "(opening)"}`;
  const [creative, grounded] = await Promise.all([
    llm(m, "draft_creative", [
      { role: "system", content: `Respond as a lively, natural voice interviewer. Prioritize conversational feel.\n${PERSONA_VOICE}\n${voiceMomentsBlock(ctx.moments)}` },
      { role: "user", content: `${base}\nReturn only the spoken text.` },
    ]),
    llm(m, "draft_grounded", [
      { role: "system", content: `Respond as a rigorous interviewer strictly grounded in the spec and transcript. ${RULES_FREE}\n${voiceMomentsBlock(ctx.moments)}` },
      { role: "user", content: `${base}\nReturn only the spoken text.` },
    ]),
  ]);
  const text = await llm(m, "merge", [
    { role: "system", content: `${PERSONA_VOICE}\nTwo candidate utterances were produced. Merge into ONE spoken turn: keep the most natural phrasing AND the most grounded content. Return only the spoken text.` },
    { role: "user", content: `A: ${creative}\nB: ${grounded}` },
  ]);
  return { text, m };
}

// --- H: draft → repair only if flagged
async function strategyH(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const raw = await llm(m, "draft", [
    { role: "system", content: `${PERSONA_VOICE}\n\nNext interviewer turn. Reason against each rule, then speak.\n${voiceMomentsBlock(ctx.moments)}\n${AGENT_CONTEXT}\nPending question: ${ctx.scenario.pendingQuestion ?? "none"}\nTranscript:\n${transcriptText(ctx.scenario.prior)}\nLearner turn: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Return JSON only: {"reasoning":{"one_real_question":{"ok":true,"why":"..."},"grounded":{"ok":true,"why":"..."},"in_persona_voice":{"ok":true,"why":"..."}},"spoken_text":"..."}` },
  ], { json: true });
  const parsed = JSON.parse(raw) as { reasoning?: Record<string, { ok?: boolean }>; spoken_text?: string };
  const flags = Object.entries(parsed.reasoning ?? {}).filter(([, v]) => v && v.ok === false).map(([k]) => k);
  let text = String(parsed.spoken_text ?? "").trim();
  if (flags.length) {
    text = await llm(m, "repair", [
      { role: "system", content: `${PERSONA_VOICE}\nFix only these problems: ${JSON.stringify(flags)}. Return only the spoken text.` },
      { role: "user", content: text },
    ]);
  }
  return { text, m, decision: { flags } };
}

// --- I: tiered models (small router + big speech)
async function strategyI(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const route = await llm(m, "route_small", [
    { role: "system", content: `Classify the learner's turn.\n${AGENT_CONTEXT}\nLearner turn: ${ctx.learner || "(opening)"}` },
    { role: "user", content: `Return JSON only: {"learner_intent":"answer|question|clarification|off_topic|stop","needs_deliberation":true|false}` },
  ], { json: true, model: SMALL_MODEL });
  const d = JSON.parse(route);
  const text = await speechCall(m, "speech", d.needs_deliberation ? "Choose the next evidence probe and ask it naturally." : "Respond naturally and yield.", ctx);
  return { text, m, decision: d };
}

// --- J: deterministic decision + free speech
async function strategyJ(ctx: Ctx, m: Metrics): Promise<StrategyResult> {
  const learnerAsks = ctx.learner.includes("?");
  const evidenceKey = learnerAsks ? PENDING_EVIDENCE : (SPECS.agent.phases[0]?.evidence_keys ?? ["claim_consistency"])[0];
  const instruction = learnerAsks
    ? `Answer the learner's question truthfully from context, then restate the pending ask: "${ctx.scenario.pendingQuestion}"`
    : `Ask one question about ${evidenceKey}.`;
  const text = await speechCall(m, "speech", instruction, ctx);
  return { text, m, decision: { deterministic: true, evidenceKey } };
}

// shared speech renderer (persona in the generation prompt, no rewrite pass)
export async function speechCall(
  m: Metrics, stage: string, contract: string, ctx: Ctx
): Promise<string> {
  return llm(m, stage, [
    { role: "system", content: `${PERSONA_VOICE}\n\n${voiceMomentsBlock(ctx.moments)}\n\nContent contract — keep this topic and intent, change the wording freely:\n${contract}\n${RULES_FREE}` },
    { role: "user", content: `Transcript:\n${transcriptText(ctx.scenario.prior)}\nLatest learner turn: ${ctx.learner || "(opening)"}\nSpeak the next interviewer turn now. Return only the spoken text.` },
  ]);
}


// ---- Strategy K: three-gate design — session/stage gate + behavior/style query gates (all LLM, small model), one free generator ----
const VOICE_AGENT_PREAMBLE = `You are a live voice agent on a phone call. Never read long text. Speak in short conversational turns. If interrupted, stop and listen. Ask about one thing at a time. Sound human, not scripted.`;

export const K_THREE_GATES: Strategy = async (ctx: Ctx, m: Metrics): Promise<StrategyResult> => {
  const base = `${AGENT_CONTEXT}\nTranscript:\n${transcriptText(ctx.scenario.prior) || "(empty — session not opened yet)"}\nPending trainer question: ${ctx.scenario.pendingQuestion ?? "none"}\nLatest learner turn: ${ctx.learner || "(no learner turn — opening)"}`;

  const [stage, queries] = await Promise.all([
    llm(m, "gate1_stage", [
      { role: "system", content: `You are the session-state gate of a voice interview system. Understand the conversation stage and what this turn must accomplish.\n${AGENT_CONTEXT}\n\nIf there is not enough context about the user, the directive should be to greet them and ask about them.` },
      { role: "user", content: `${base}\nReturn JSON only: {"stage":"opening|responding|side_question|wrapping","directive":"one sentence: what this turn is for","enough_user_context":true|false}` },
    ], { json: true, model: SMALL_MODEL }),
    llm(m, "gate23_queries", [
      { role: "system", content: `You are the retrieval gate of a voice interviewer. Given the scenario and conversation state, craft two search queries against a database of ${persona.name}'s real past interview lines: one for his asking/opening BEHAVIOR at this stage, one for his phrasing STYLE for this kind of turn.` },
      { role: "user", content: `${base}\nReturn JSON only: {"behavior_query":"...","style_query":"..."}` },
    ], { json: true, model: SMALL_MODEL }),
  ]);
  const stageOut = JSON.parse(stage);
  const q = JSON.parse(queries);

  let moments: { text: string }[] = [];
  if (ctx.retrieve) {
    const [behaviorMoments, styleMoments] = await Promise.all([
      ctx.retrieve(q.behavior_query, 4),
      ctx.retrieve(q.style_query, 4),
    ]);
    moments = [...behaviorMoments, ...styleMoments];
  }

  const raw = await llm(m, "generate", [
    { role: "system", content: `${VOICE_AGENT_PREAMBLE}\n\n${PERSONA_VOICE}\n\n${voiceMomentsBlock(moments)}\n\nSession gate says — stage: ${stageOut.stage}; do this: ${stageOut.directive}\n${RULES_FREE}` },
    { role: "user", content: `Transcript:\n${transcriptText(ctx.scenario.prior)}\nLatest learner turn: ${ctx.learner || "(opening)"}\nSpeak the next interviewer turn now. Return only the spoken text.` },
  ]);
  return { text: raw.trim(), m, decision: { stage: stageOut.stage, directive: stageOut.directive, behavior_query: q.behavior_query, style_query: q.style_query, moments: moments.length } };
};

export const STRATEGIES: Record<string, Strategy> = {
  K_three_gates: K_THREE_GATES,
  V2_current: strategyV2,
  A_gen_validate_rephrase: strategyA,
  B_decide_gen_rephrase: strategyB,
  C_gen_validate_loop: strategyC,
  D_router_fork: strategyD,
  E_one_call_selfcheck: strategyE,
  F_speak_now_async: strategyF,
  G_dual_draft_judge: strategyG,
  H_draft_repair_if_flagged: strategyH,
  I_tiered_models: strategyI,
  J_deterministic_decide: strategyJ,
};

// ---------- judge ----------

export async function judge(scenario: Scenario, response: string, m: Metrics): Promise<any> {
  const pending = scenario.pendingQuestion ?? "none";
  const raw = await llm(m, "judge", [
    { role: "system", content: `You are judging a mock-interview trainer's spoken turn. Score 1-5 each dimension (5 = excellent):
- appropriateness: right response to the learner's turn (answers side questions instead of ignoring them; deepens real answers; greets on opening)
- naturalness: sounds like a human interviewer mid-conversation, not a form-filling bot; no forced question when none is needed; no template cadence
- persona: consistent with a demanding-but-encouraging senior interviewer voice
- grounding: GROUND TRUTH: no resume or document was uploaded for this session. Claiming to have/see/access one, or inventing candidate facts, is grounding=1. Using unestablished specifics ("you mentioned X") is also ungrounded.
- non_repetitive: does not parrot or re-ask the pending question when the learner asked something else
Judge strictly; 3 = acceptable, 5 = you'd hear this from a great human interviewer.` },
    { role: "user", content: `Pending trainer question: ${pending}\nTranscript:\n${transcriptText(scenario.prior)}\nLearner turn: ${scenario.learner || "(opening)"}\nTrainer response: ${response}\nReturn JSON only: {"appropriateness":n,"naturalness":n,"persona":n,"grounding":n,"non_repetitive":n,"overall":n,"why":"one sentence"}` },
  ], { json: true });
  try {
    const j = JSON.parse(raw);
    return {
      appropriateness: +j.appropriateness || 0, naturalness: +j.naturalness || 0, persona: +j.persona || 0,
      grounding: +j.grounding || 0, non_repetitive: +j.non_repetitive || 0, overall: +j.overall || 0, why: j.why ?? "",
    };
  } catch { return { appropriateness: 0, naturalness: 0, persona: 0, grounding: 0, non_repetitive: 0, overall: 0, why: "unparseable judge output" }; }
}

