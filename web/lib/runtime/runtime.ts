/**
 * Interview spec-driven runtime.
 * Direct 1:1 port of select_action, analyzer, and persona renderer from agent/runner.py.
 */

import {
  type AgentSpec,
  type ClaimHandling,
  type ClaimProvenance,
  type Classification,
  type DomainSpec,
  type PersonaSpec,
  type PhaseSpec,
} from "./compiler";

export const INCIDENT_LANES = new Set(["challenges", "failure_behavior"]);

export interface EvidenceUpdate {
  key: string;
  status: "partial" | "sufficient";
  evidence: string;
  quote: string;
  provenance: ClaimProvenance;
}

export interface ClaimAssessment {
  statement: string;
  provenance: ClaimProvenance;
  basis: string;
  evidence_key?: string | null;
  material?: boolean;
}

export interface AnswerAnalysis {
  classification: Classification;
  learner_intent: "answer" | "question" | "clarification" | "stop";
  valid_evidence: string[];
  evidence_updates: EvidenceUpdate[];
  claim_assessments: ClaimAssessment[];
  unresolved_point: string;
  unresolved_evidence_key?: string | null;
  contradiction?: string | null;
  important_term?: string | null;
}

export interface InterviewAction {
  name: string;
  evidence_key: string | null;
  reason: string;
  intent: string;
  fallback_text?: string | null;
  close: boolean;
  expects_answer: boolean;
}

export interface RuntimeState {
  phase_index: number;
  phase_turns: number;
  learner_turns: number;
  coverage: Record<string, "untested" | "partial" | "sufficient" | "weak" | "unresolved" | string>;
  claims: Array<{ statement: string; provenance: string; evidence_key?: string | null; status?: string }>;
  evidence_probe_counts: Record<string, number>;
  pending_evidence_key: string | null;
  actions: string[];
  grounding_probes: string[];
  grounding_probe_counts: Record<string, number>;
  end_reason?: string;
  current_surface?: string | null;
}

export function initRuntimeState(): RuntimeState {
  return {
    phase_index: 0,
    phase_turns: 0,
    learner_turns: 0,
    coverage: {},
    claims: [],
    evidence_probe_counts: {},
    pending_evidence_key: null,
    actions: [],
    grounding_probes: [],
    grounding_probe_counts: {},
    current_surface: null,
  };
}

export function surfaceForPhase(
  agent: AgentSpec,
  index: number
): { action: string; payload: Record<string, unknown> } | null {
  if (!agent.phases || index < 0 || index >= agent.phases.length) {
    return null;
  }
  const phase = agent.phases[index];
  for (const tool of phase.tools || []) {
    if (
      tool === "coding_sandbox" ||
      (typeof tool === "object" && tool !== null && (tool as { id?: string }).id === "coding_sandbox")
    ) {
      let language =
        typeof tool === "object" && tool !== null && (tool as { language?: string }).language
          ? (tool as { language?: string }).language!
          : "python";
      if (language === "candidate_choice") language = "python";
      return { action: "open_code_editor", payload: { language } };
    }
  }
  const scenario = (phase.scenario as Record<string, unknown>) || {};
  if (scenario.surface === "whiteboard") {
    return { action: "open_whiteboard", payload: {} };
  }
  if (typeof scenario.pdf_url === "string") {
    return { action: "open_pdf", payload: { sourceUrl: scenario.pdf_url } };
  }
  if (typeof scenario.presentation_url === "string") {
    return { action: "open_presentation", payload: { sourceUrl: scenario.presentation_url } };
  }
  return null;
}

export function activePhase(agent: AgentSpec, state: RuntimeState): PhaseSpec | null {
  return agent.phases[state.phase_index ?? 0] ?? null;
}

export function activeEvidence(agent: AgentSpec, state: RuntimeState): Record<string, string> {
  const phase = activePhase(agent, state);
  if (!phase) return agent.required_evidence;
  const result: Record<string, string> = {};
  for (const key of phase.evidence_keys) {
    if (key in agent.required_evidence) {
      result[key] = agent.required_evidence[key];
    }
  }
  return result;
}

export function activeClaimHandling(agent: AgentSpec, state: RuntimeState): ClaimHandling {
  const phase = activePhase(agent, state);
  return phase?.claim_handling ?? agent.claim_handling;
}

export function activeScenario(agent: AgentSpec, state: RuntimeState): Record<string, unknown> {
  const phase = activePhase(agent, state);
  return { ...agent.scenario, ...(phase?.scenario ?? {}) };
}

export function activeAllowedActions(agent: AgentSpec, state: RuntimeState): string[] {
  const phase = activePhase(agent, state);
  return phase?.allowed_actions ?? agent.allowed_actions;
}

export function activeDefaultAction(agent: AgentSpec, state: RuntimeState): string {
  const phase = activePhase(agent, state);
  const allowed = activeAllowedActions(agent, state);
  const preferred = phase?.default_action ?? agent.default_action;
  if (allowed.includes(preferred)) return preferred;
  const fallback = allowed.find((a) => a !== "close_session" && a !== "transition_phase");
  return fallback ?? allowed[0];
}

export function renderRules(agent: AgentSpec, state: RuntimeState): Record<string, any> {
  const phase = activePhase(agent, state);
  return {
    maximum_words: 45,
    maximum_question_marks: 1,
    one_focal_ask: true,
    ...agent.rendering,
    ...(phase?.rendering ?? {}),
  };
}

export function nextEvidence(
  state: RuntimeState,
  required: Record<string, string>,
  completionKeys?: string[]
): string {
  const keys = Object.keys(required);
  const core = completionKeys && completionKeys.length ? completionKeys : keys;
  const coreSet = new Set(core);
  const optional = keys.filter((k) => !coreSet.has(k));

  const stages: Array<[string[], string[]]> = [
    [core, ["untested"]],
    [core, ["partial"]],
    [optional, ["untested"]],
    [optional, ["partial"]],
    [[...core, ...optional], ["weak", "unresolved"]],
  ];

  for (const [candidates, statuses] of stages) {
    for (const status of statuses) {
      const match = candidates.find((key) => (state.coverage[key] ?? "untested") === status);
      if (match) return match;
    }
  }
  return core[core.length - 1];
}

export function isHypothetical(text: string): boolean {
  return /\b(if|would|typically|in the event of|when .* would)\b/i.test(text);
}

export function validateAnalysis(
  raw: AnswerAnalysis,
  agent: AgentSpec,
  state: RuntimeState,
  learnerText?: string | null
): { applied: AnswerAnalysis; corrections: string[] } {
  const allowed = activeEvidence(agent, state);
  const corrections: string[] = [];
  const updates: EvidenceUpdate[] = [];
  const seen = new Set<string>();

  const unresolvedKey =
    raw.unresolved_evidence_key && raw.unresolved_evidence_key in allowed
      ? raw.unresolved_evidence_key
      : null;

  if (raw.unresolved_evidence_key && !unresolvedKey) {
    corrections.push(`discarded inactive unresolved key: ${raw.unresolved_evidence_key}`);
  }

  for (let update of raw.evidence_updates ?? []) {
    if (!(update.key in allowed) || seen.has(update.key) || !update.evidence?.trim()) {
      corrections.push(`discarded invalid evidence update: ${update.key}`);
      continue;
    }
    if (learnerText != null && (!update.quote?.trim() || !learnerText.includes(update.quote))) {
      corrections.push(`discarded unquoted evidence update: ${update.key}`);
      continue;
    }
    if (
      activeClaimHandling(agent, state) === "coding_execution" &&
      update.key.split(".").pop() === "execution_result"
    ) {
      corrections.push("execution credit requires a trusted workspace result, not speech");
      continue;
    }
    seen.add(update.key);
    if (update.status === "sufficient" && update.key === unresolvedKey) {
      update = { ...update, status: "partial" };
      corrections.push(`downgraded conflicting unresolved update: ${update.key}`);
    }
    updates.push(update);
    if (updates.length === 2) {
      if ((raw.evidence_updates?.length ?? 0) > 2) {
        corrections.push("trimmed evidence updates to two");
      }
      break;
    }
  }

  const applied: AnswerAnalysis = {
    ...raw,
    evidence_updates: updates,
    unresolved_evidence_key: unresolvedKey,
  };

  return { applied, corrections };
}

export function applyEvidenceUpdates(
  analysis: AnswerAnalysis,
  state: RuntimeState,
  required: Record<string, string>,
  resumeGrounding: boolean
): ClaimAssessment[] {
  const groundingCandidates: ClaimAssessment[] = [];

  for (const claim of analysis.claim_assessments ?? []) {
    const lane = (claim.evidence_key ?? "").split(".").pop() ?? "";
    if (
      resumeGrounding &&
      claim.material &&
      (claim.provenance === "unverified_elaboration" || claim.provenance === "hypothetical") &&
      (INCIDENT_LANES.has(lane) || analysis.classification === "unsupported")
    ) {
      groundingCandidates.push(claim);
    }
  }

  for (const update of analysis.evidence_updates ?? []) {
    if (update.key in required) {
      const lane = update.key.split(".").pop() ?? "";
      const hypothetical = update.provenance === "hypothetical" || isHypothetical(update.evidence);
      let status = update.status;

      if (resumeGrounding && INCIDENT_LANES.has(lane) && update.provenance !== "observed_incident") {
        status = "partial";
      }
      if (status === "sufficient" && update.key === analysis.unresolved_evidence_key) {
        status = "partial";
      }

      const current = state.coverage[update.key] ?? "untested";
      const contradictedLane =
        analysis.classification === "contradictory" &&
        update.key === analysis.unresolved_evidence_key;

      if (current !== "sufficient" || status === "sufficient" || contradictedLane) {
        state.coverage[update.key] = status;
      }

      if (resumeGrounding && hypothetical && INCIDENT_LANES.has(lane)) {
        groundingCandidates.push({
          statement: update.evidence,
          provenance: "hypothetical",
          basis: "A hypothetical behavior is not evidence of an observed incident.",
          evidence_key: update.key,
          material: true,
        });
      }
    }
  }

  return groundingCandidates;
}

export function markProbeExhaustion(
  state: RuntimeState,
  required: Record<string, string>,
  _unresolvedKey?: string | null,
  maximum = 2
): void {
  for (const key of Object.keys(required)) {
    const status = state.coverage[key] ?? "untested";
    const count = state.evidence_probe_counts[key] ?? 0;
    if (count >= maximum && (status === "untested" || status === "partial")) {
      state.coverage[key] = "weak";
    }
  }
}

export function expirePhase(state: RuntimeState, completionKeys: string[]): void {
  for (const key of completionKeys) {
    const status = state.coverage[key] ?? "untested";
    if (status === "untested") {
      state.coverage[key] = "unresolved";
    } else if (status !== "sufficient") {
      state.coverage[key] = "weak";
    }
  }
}

export function pickGroundingTarget(
  state: RuntimeState,
  candidates: ClaimAssessment[]
): ClaimAssessment | null {
  const probed = new Set(state.grounding_probes ?? []);
  const counts = state.grounding_probe_counts ?? {};
  return (
    candidates.find(
      (c) => !probed.has(c.statement) && (counts[c.evidence_key ?? "claim"] ?? 0) < 1
    ) ?? null
  );
}

export function evidenceLabel(key?: string | null): string {
  return (key ?? "this point").split(".").pop()?.replace(/_/g, " ") ?? "this point";
}

export function closingAction(state: RuntimeState, agent: AgentSpec): InterviewAction {
  const completionKeys = Array.from(
    new Set(
      agent.phases
        .filter((p) => p.claim_handling !== "session_feedback")
        .flatMap((p) => p.completion_keys)
    )
  );
  const keysToCheck = completionKeys.length ? completionKeys : Object.keys(agent.required_evidence);
  const gaps = keysToCheck.filter((k) => state.coverage[k] !== "sufficient");

  if (gaps.length > 0) {
    const labels = gaps.slice(0, 3).map(evidenceLabel);
    const summary =
      labels.length > 1
        ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
        : labels[0];

    const subjectMap: Record<string, string> = {
      "resume-mastery": "resume claims",
      "fundamentals-depth": "concepts and reasoning",
      "real-world-system-design": "requirements, design, and adaptation",
    };
    const subject = subjectMap[agent.id] ?? "evidence";
    const text = `We’ll stop here. The main areas to strengthen are ${summary}; they need more evidence or practice.`;

    return {
      name: "close_session",
      evidence_key: null,
      reason: "The session ended with unresolved core evidence.",
      intent: `Close the ${subject} session using the supplied gap labels. Ask no question.`,
      fallback_text: text,
      close: true,
      expects_answer: false,
    };
  }

  const successMap: Record<string, string> = {
    "resume-mastery":
      "We’ve covered the core areas for these resume claims, including ownership, mechanism, and impact. We’ll stop here.",
    "fundamentals-depth":
      "We’ve covered the core concepts, reasoning, and application for this topic. We’ll stop here.",
    "real-world-system-design":
      "We’ve covered the core requirements, design, and adaptation decisions. We’ll stop here.",
  };
  const text = successMap[agent.id] ?? "We’ve covered the core areas for this session. We’ll stop here.";

  return {
    name: "close_session",
    evidence_key: null,
    reason: "All core evidence was established.",
    intent: "Close accurately without claiming factual truth. Ask no question.",
    fallback_text: text,
    close: true,
    expects_answer: false,
  };
}

export function selectAction(
  analysis: AnswerAnalysis,
  state: RuntimeState,
  persona: PersonaSpec,
  agent: AgentSpec
): InterviewAction {
  const phase = activePhase(agent, state);
  const required = activeEvidence(agent, state);
  const defaultAction = activeDefaultAction(agent, state);
  const maxProbes = phase?.max_probes_per_lane ?? 2;

  if (
    analysis.learner_intent === "stop" ||
    (analysis.learner_intent !== "answer" && state.learner_turns >= agent.max_learner_turns)
  ) {
    return closingAction(state, agent);
  }

  if (analysis.learner_intent === "question" || analysis.learner_intent === "clarification") {
    const reqKeys = Object.keys(required);
    const key =
      state.pending_evidence_key && state.pending_evidence_key in required
        ? state.pending_evidence_key
        : reqKeys[0];
    const allowed = activeAllowedActions(agent, state);
    const reveal =
      activeClaimHandling(agent, state) === "hypothetical_design" &&
      allowed.includes("reveal_requirement");

    return {
      name: reveal ? "reveal_requirement" : defaultAction,
      evidence_key: key,
      reason: "Answer the learner's question without changing the assessment state.",
      intent:
        "Respond to the learner's actual question using the allowed context and references. " +
        "Reveal only requested scenario facts. If unknown, say so. Clarify or give a narrow hint, " +
        "not the full assessment answer. Return gently to the pending question without repeating it verbatim.",
      close: false,
      expects_answer: false,
    };
  }

  const resumeGrounding = activeClaimHandling(agent, state) === "resume_evidence";
  const normalizedClaims = (analysis.claim_assessments ?? []).map((claim) =>
    resumeGrounding && isHypothetical(claim.statement)
      ? { ...claim, provenance: "hypothetical" as ClaimProvenance }
      : claim
  );

  const knownStatements = new Set(state.claims.map((c) => c.statement));
  for (const claim of normalizedClaims) {
    if (!knownStatements.has(claim.statement)) {
      state.claims.push(claim);
      knownStatements.add(claim.statement);
    }
  }

  const groundingCandidates = applyEvidenceUpdates(analysis, state, required, resumeGrounding);
  const completionKeys = phase?.completion_keys ?? Object.keys(required);

  markProbeExhaustion(state, required, analysis.unresolved_evidence_key, maxProbes);
  const nextKey = nextEvidence(state, required, completionKeys);
  const unresolvedKey = analysis.unresolved_evidence_key;

  const probeCount = unresolvedKey ? state.evidence_probe_counts[unresolvedKey] ?? 0 : 0;
  const unresolvedIsActionable = Boolean(
    unresolvedKey &&
      unresolvedKey in required &&
      !["sufficient", "weak", "unresolved"].includes(state.coverage[unresolvedKey] ?? "untested") &&
      probeCount < maxProbes &&
      !(probeCount > 0 && completionKeys.some((k) => (state.coverage[k] ?? "untested") === "untested"))
  );

  let evidenceKey = unresolvedIsActionable && unresolvedKey ? unresolvedKey : nextKey;
  const groundingClaim = pickGroundingTarget(state, groundingCandidates);
  if (groundingClaim && groundingClaim.evidence_key && groundingClaim.evidence_key in required) {
    evidenceKey = groundingClaim.evidence_key;
  }

  const turnBudgetReached = state.learner_turns >= agent.max_learner_turns;
  const phaseBudgetReached = Boolean(phase && state.phase_turns >= phase.max_learner_turns);

  if (phaseBudgetReached) {
    expirePhase(state, completionKeys);
  }

  const coverageComplete = completionKeys.every((k) =>
    ["sufficient", "weak", "unresolved"].includes(state.coverage[k] ?? "untested")
  );
  const minimumReached = !phase || state.phase_turns >= phase.min_learner_turns;
  let phaseComplete =
    phaseBudgetReached || (coverageComplete && minimumReached && groundingClaim === null);

  if (phase?.claim_handling === "session_feedback") {
    phaseComplete = minimumReached;
  }

  if (
    turnBudgetReached ||
    (phaseComplete && (!phase || state.phase_index === agent.phases.length - 1))
  ) {
    return closingAction(state, agent);
  }

  if (phase && phaseComplete) {
    state.phase_index = (state.phase_index ?? 0) + 1;
    state.phase_turns = 0;
    const nextPhaseSpec = activePhase(agent, state);
    const nextPhaseKey = nextPhaseSpec ? nextPhaseSpec.evidence_keys[0] : evidenceKey;
    const feedback = nextPhaseSpec?.claim_handling === "session_feedback";
    const allowed = activeAllowedActions(agent, state);

    return {
      name:
        feedback && allowed.includes("present_feedback")
          ? "present_feedback"
          : "transition_phase",
      evidence_key: nextPhaseKey,
      reason: `${phase.name} is complete; continue to ${nextPhaseSpec?.name ?? "next phase"}.`,
      intent:
        (feedback
          ? "Summarize only demonstrated strengths and unresolved gaps from the recorded session evidence. Offer one practice step and invite the learner's reflection. Do not invent a score or mastery. "
          : `Briefly move from ${phase.name} to ${nextPhaseSpec?.name ?? "next phase"}; budget exhaustion is not mastery. `) +
        `Begin this objective: ${nextPhaseSpec?.objective ?? ""}. ${nextPhaseSpec?.opening ?? ""}`,
      close: false,
      expects_answer: true,
    };
  }

  const clarifiedScenario = Boolean(
    phase &&
      phase.id === "problem-understanding" &&
      (analysis.evidence_updates ?? []).some(
        (u) => u.key.split(".").pop() === "clarifying_questions"
      )
  );

  let action =
    analysis.classification === "contradictory"
      ? "surface_contradiction"
      : groundingClaim
      ? "request_justification"
      : clarifiedScenario && Object.keys(activeScenario(agent, state)).length > 0
      ? "reveal_requirement"
      : persona.decision_preferences[analysis.classification] ?? defaultAction;

  const allowedActions = activeAllowedActions(agent, state);
  if (!allowedActions.includes(action)) {
    action = defaultAction;
  }

  if (action.startsWith("deepen_") && state.actions.slice(-1)[0] === action) {
    action = defaultAction;
  }
  const lastTwo = state.actions.slice(-2);
  if (lastTwo.length === 2 && lastTwo[0] === action && lastTwo[1] === action) {
    action = allowedActions.includes("isolate_missing_part")
      ? "isolate_missing_part"
      : defaultAction;
  }

  let reason = analysis.contradiction || analysis.unresolved_point;
  const revisiting = (state.evidence_probe_counts[evidenceKey] ?? 0) > 0;
  let intent = "";

  if (action === "surface_contradiction") {
    intent = `State both conflicting claims neutrally, then ask the learner to reconcile them: ${reason}`;
  } else if (action === "request_justification" && groundingClaim) {
    state.grounding_probes.push(groundingClaim.statement);
    const lane = groundingClaim.evidence_key ?? "claim";
    state.grounding_probe_counts[lane] = (state.grounding_probe_counts[lane] ?? 0) + 1;
    reason = groundingClaim.basis;
    const laneName = (groundingClaim.evidence_key ?? "").split(".").pop() ?? "";
    if (INCIDENT_LANES.has(laneName)) {
      intent =
        `Ask for one specific incident that actually occurred, including the observed symptom and response. ` +
        `Do not accept expected system behavior as an incident: ${groundingClaim.statement}`;
    } else {
      intent =
        `Ask for the concrete mechanism, measurement, or direct evidence supporting this unverified elaboration: ` +
        groundingClaim.statement;
    }
  } else if (action === "request_justification") {
    intent = `Ask what concrete mechanism, measurement, or evidence supports this claim: ${analysis.unresolved_point}`;
  } else if (action === "reveal_requirement") {
    intent =
      "Answer the candidate's relevant clarification questions using only the hidden scenario facts. " +
      "Reveal requested facts, not the entire scenario, then ask what requirement or assumption they would establish next.";
  } else if (action === defaultAction) {
    reason = `The current thread has enough depth for now; the Agent still needs ${evidenceKey}.`;
    intent =
      `Ask exactly one short question designed to establish ${evidenceKey}. ` +
      (revisiting
        ? `Do not repeat the earlier broad question; target only this missing point: ${analysis.unresolved_point}. `
        : "") +
      "Stay with the learner's current topic when possible; acknowledge the valid part and ask one focused follow-up.";
  } else {
    intent =
      `Ask exactly one short question to establish ${evidenceKey}: ${agent.required_evidence[evidenceKey] ?? ""} ` +
      `Use this unresolved point only if it directly supports that lane: ${analysis.unresolved_point}. ` +
      (revisiting ? "Do not repeat the earlier broad question; ask only for the missing detail. " : "") +
      "Use the persona's acknowledgment, paraphrase or hint when appropriate; keep one focal ask.";
  }

  return {
    name: action,
    evidence_key: evidenceKey,
    reason,
    intent,
    close: false,
    expects_answer: true,
  };
}

export function validateAction(
  action: InterviewAction,
  agent: AgentSpec,
  state: RuntimeState
): string[] {
  if (!activeAllowedActions(agent, state).includes(action.name)) {
    return ["action is not allowed"];
  }
  if (action.close) {
    return action.evidence_key === null ? [] : ["closing targets evidence"];
  }
  const allowed = activeEvidence(agent, state);
  if (!action.evidence_key || !(action.evidence_key in allowed)) {
    return ["action targets inactive evidence"];
  }
  return [];
}

export function validateRendered(
  text: string,
  action: InterviewAction,
  agent: AgentSpec,
  state: RuntimeState
): string[] {
  const errors: string[] = [];
  const rules = renderRules(agent, state);

  if (!text.trim()) {
    errors.push("empty response");
  }
  const questions = (text.match(/\?/g) || []).length;
  if (action.close && questions > 0) {
    errors.push("closing contains a question");
  } else if (questions > rules.maximum_question_marks) {
    errors.push("too many questions");
  } else if (
    !action.close &&
    action.expects_answer &&
    rules.maximum_question_marks > 0 &&
    questions !== 1
  ) {
    errors.push("response must invite one learner answer");
  }

  const words = text.trim().split(/\s+/).length;
  if (words > rules.maximum_words) {
    errors.push(`response exceeds ${rules.maximum_words} words`);
  }

  if (/\bI (built|implemented|designed|architected|deployed|chose|fixed|led)\b/i.test(text)) {
    errors.push("role reversal");
  }
  if (
    /\b(that(?:'s| is) solid|you(?:'ve| have) clearly|well reasoned|that makes sense)\b/i.test(text)
  ) {
    errors.push("generic praise");
  }
  for (const key of Object.keys(agent.required_evidence)) {
    if (key.includes("_") && text.includes(key)) {
      errors.push("internal evidence key leaked");
      break;
    }
  }

  const forbidden: string[] = rules.forbidden_terms ?? [];
  for (const term of forbidden) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) {
      errors.push("response uses a term forbidden by the stage");
      break;
    }
  }

  return errors;
}

export function feedbackSummary(agent: AgentSpec, state: RuntimeState): string {
  const keys = agent.phases
    .filter((p) => p.claim_handling !== "session_feedback")
    .flatMap((p) => p.completion_keys);
  const strengths = keys.filter((k) => state.coverage[k] === "sufficient").map(evidenceLabel);
  const gaps = keys.filter((k) => state.coverage[k] !== "sufficient").map(evidenceLabel);

  const parts: string[] = [];
  if (strengths.length) {
    parts.push(`You demonstrated ${strengths.slice(0, 2).join(", ")}.`);
  }
  if (gaps.length) {
    parts.push(`We still need evidence for ${gaps.slice(0, 2).join(", ")}.`);
  }
  parts.push("What would you practice next?");
  return parts.join(" ");
}

export function deterministicFallback(
  action: InterviewAction,
  agent: AgentSpec,
  state: RuntimeState
): string {
  if (action.close) {
    return action.fallback_text || "We’ll stop here.";
  }
  const label = evidenceLabel(action.evidence_key);
  const rules = renderRules(agent, state);
  const hasQuestion = rules.maximum_question_marks > 0;

  if (action.name === "surface_contradiction") {
    return hasQuestion
      ? "How do you reconcile those two claims?"
      : "Please reconcile those two claims.";
  }
  if (action.name === "reveal_requirement") {
    return "Which remaining requirement or assumption would you clarify next?";
  }
  if (action.intent.includes("specific incident")) {
    return `What specific observed incident demonstrates ${label}?`;
  }
  if (action.name === "present_feedback") {
    return feedbackSummary(agent, state);
  }
  return hasQuestion
    ? `Could you explain ${label} in your own words?`
    : `Please explain ${label} in your own words.`;
}

export function relevantContext(contextText: string, focus: string, maxChars = 3500): string {
  if (!contextText.trim()) return "";
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "from", "was", "were",
    "have", "has", "are", "their", "its", "how", "what", "when", "which",
    "establish", "active",
  ]);
  const terms = new Set(
    (focus.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !stop.has(t))
  );

  const paragraphs = contextText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const units: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= 400) {
      units.push(p);
    } else {
      const sentences = p.split(/(?<=[.!?])\s+\n?|\n+/).map((s) => s.trim()).filter(Boolean);
      units.push(...sentences);
    }
  }

  if (!units.length || !terms.size) {
    return contextText.slice(0, maxChars);
  }

  const score = (unit: string) => {
    const words = unit.toLowerCase().match(/[a-z0-9]+/g) || [];
    let count = 0;
    for (const w of words) {
      if (terms.has(w)) count++;
    }
    return count;
  };

  const sorted = units
    .map((u) => ({ unit: u, score: score(u) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected: string[] = [];
  let size = 0;
  for (const item of sorted) {
    selected.push(item.unit);
    size += item.unit.length;
    if (size >= maxChars) break;
  }

  return selected.length ? selected.join("\n") : contextText.slice(0, maxChars);
}
