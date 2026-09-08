export const personaCollectionName = (personaId: string) => `persona_${personaId}`;

export function shouldRebuildPersona(
  sources: { id: string; status: string }[],
  triggerSourceId?: string,
) {
  return sources.length > 0
    && sources.every((source) => source.status === "analyzed")
    && (!triggerSourceId || sources[0].id === triggerSourceId);
}

/** Build searchable, source-grounded conversation moments from Gemini analysis. */
export function extractPersonaVoiceChunks(analysis: unknown): string[] {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return [];
  const data = analysis as Record<string, unknown>;
  const chunks: string[] = [];
  const seenResponses = new Set<string>();
  const add = (response: unknown, action: unknown, context?: unknown) => {
    if (typeof response !== "string" || !response.trim()) return;
    const clean = response.trim();
    const key = clean.toLowerCase();
    if (seenResponses.has(key)) return;
    seenResponses.add(key);
    chunks.push([
      typeof context === "string" && context.trim() ? `Candidate: ${context.trim()}` : null,
      typeof action === "string" && action.trim() ? `Action: ${action.trim()}` : null,
      `Interviewer: ${clean}`,
    ].filter(Boolean).join("\n"));
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
        for (const example of pattern.examples) add(example, pattern.action, `Situation: ${situation}`);
      }
    }
  }
  if (data.verbatim_phrases && typeof data.verbatim_phrases === "object" && !Array.isArray(data.verbatim_phrases)) {
    for (const [action, phrases] of Object.entries(data.verbatim_phrases as Record<string, unknown>)) {
      if (Array.isArray(phrases)) for (const phrase of phrases) add(phrase, action);
    }
  }
  return chunks;
}
