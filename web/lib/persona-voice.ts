export const personaCollectionName = (personaId: string) => `persona_${personaId}`;

export type PersonaVoiceMoment = {
  text: string;
  action?: string;
  learnerState?: string;
  move?: string;
  candidateContext?: string;
};

const INTERVIEWER_EMBED_CHARS = 400;
const CANDIDATE_META_CHARS = 200;

const ACTION_LEARNER_STATE: Record<string, string> = {
  ask_exact_example: "vague",
  request_justification: "vague",
  isolate_missing_part: "partial",
  scaffold_missing_link: "partial",
  surface_contradiction: "off_track",
  narrow_hint: "confused",
  deepen_with_tradeoff: "strong",
  deepen_with_edge_case: "strong",
  ask_reflection: "strong",
  ask_reflective_walkthrough: "strong",
  redirect_role: "off_track",
  close_session: "stop",
};

const PATTERN_LEARNER_STATE: Record<string, string> = {
  on_vague_answer: "vague",
  on_unsupported_claim: "vague",
  on_partial_answer: "partial",
  on_strong_answer: "strong",
  on_contradictory_answer: "off_track",
  on_unknown: "confused",
};

const ACTION_MOVE: Record<string, string> = {
  narrow_hint: "hint",
  scaffold_missing_link: "hint",
  close_session: "close",
  present_feedback: "close",
};

export function shouldRebuildPersona(
  sources: { id: string; status: string }[],
  triggerSourceId?: string,
) {
  return sources.length > 0
    && sources.every((source) => source.status === "analyzed")
    && (!triggerSourceId || sources[0].id === triggerSourceId);
}

function inferLearnerState(action?: string, patternKey?: string): string | undefined {
  if (patternKey && PATTERN_LEARNER_STATE[patternKey]) return PATTERN_LEARNER_STATE[patternKey];
  if (action && ACTION_LEARNER_STATE[action]) return ACTION_LEARNER_STATE[action];
  return undefined;
}

function inferMove(action?: string, fallback = "probe"): string {
  if (action && ACTION_MOVE[action]) return ACTION_MOVE[action];
  return fallback;
}

function clip(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function knownAction(action?: string): string | undefined {
  if (!action) return undefined;
  return ACTION_LEARNER_STATE[action] || ACTION_MOVE[action] ? action : undefined;
}

function formatEmbedText(response: string, action?: string): string {
  return [
    action ? `Action: ${action}` : null,
    `Interviewer: ${clip(response, INTERVIEWER_EMBED_CHARS)}`,
  ].filter(Boolean).join("\n");
}

/** Structured conversation moments from Gemini analysis. */
export function extractPersonaVoiceMoments(analysis: unknown): PersonaVoiceMoment[] {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return [];
  const data = analysis as Record<string, unknown>;
  const moments: PersonaVoiceMoment[] = [];
  const seenResponses = new Set<string>();
  const add = (response: unknown, action: unknown, context?: unknown, patternKey?: string, move?: string) => {
    if (typeof response !== "string" || !response.trim()) return;
    const clean = response.trim();
    const key = clean.toLowerCase();
    if (seenResponses.has(key)) return;
    seenResponses.add(key);
    const rawAction = typeof action === "string" && action.trim() ? action.trim() : undefined;
    const actionName = knownAction(rawAction);
    const candidateContext = typeof context === "string" && context.trim() && !context.startsWith("Situation:")
      ? clip(context, CANDIDATE_META_CHARS)
      : undefined;
    moments.push({
      text: formatEmbedText(clean, actionName),
      action: actionName,
      learnerState: inferLearnerState(actionName, patternKey),
      move: move ?? inferMove(actionName),
      candidateContext,
    });
  };

  if (Array.isArray(data.conversation_moments)) {
    for (const item of data.conversation_moments) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const moment = item as Record<string, unknown>;
      add(moment.interviewer_response, moment.action, moment.candidate_context);
    }
  }
  if (data.behavioral_patterns && typeof data.behavioral_patterns === "object" && !Array.isArray(data.behavioral_patterns)) {
    for (const [situation, value] of Object.entries(data.behavioral_patterns as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const pattern = value as Record<string, unknown>;
      if (Array.isArray(pattern.examples)) {
        for (const example of pattern.examples) add(example, pattern.action, `Situation: ${situation}`, situation);
      }
    }
  }
  if (data.verbatim_phrases && typeof data.verbatim_phrases === "object" && !Array.isArray(data.verbatim_phrases)) {
    for (const [action, phrases] of Object.entries(data.verbatim_phrases as Record<string, unknown>)) {
      if (Array.isArray(phrases)) for (const phrase of phrases) add(phrase, action, undefined, undefined, "probe");
    }
  }
  return moments;
}

/** Build searchable, source-grounded conversation moments from Gemini analysis. */
export function extractPersonaVoiceChunks(analysis: unknown): string[] {
  return extractPersonaVoiceMoments(analysis).map((moment) => moment.text);
}

export function personaCoverageLevel(
  sources: { metadata?: unknown }[]
): "low" | "medium" | "high" {
  let moments = 0;
  const actions = new Set<string>();
  for (const source of sources) {
    const metadata = source.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const record = metadata as Record<string, unknown>;
    if (typeof record.voiceMoments === "number") moments += record.voiceMoments;
    if (Array.isArray(record.voiceActions)) {
      for (const action of record.voiceActions) if (typeof action === "string" && action) actions.add(action);
    }
  }
  if (moments >= 50 && actions.size >= 6) return "high";
  if (moments >= 20 && actions.size >= 3) return "medium";
  return "low";
}
