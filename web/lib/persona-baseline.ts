import { db } from "@/lib/db";
import { MainCollectionService } from "@/lib/main-collection";

/**
 * Assembles the trainer-facing "baseline" for a persona: the two pillars the
 * trainer cares about — how the twin *talks* (style/voice) and how it *decides*
 * (interviewing moves). Read-only; pulls from data that already exists.
 *
 * Honesty note: only the corpus `fingerprint` and `decisionPolicy` are enforced
 * at runtime (see compareStyleRates + selectAction). The style/language/
 * calibration prose is descriptive extraction — the UI labels it as such.
 */

export type VoiceFingerprint = {
  turns: number;
  learner_name_use_rate: number;
  doubled_acknowledgement_rate: number;
  thanks_turn_start_rate: number;
  average_spoken_words: number;
  average_questions: number;
};

export type DecisionPolicyRow = {
  state: string;
  move: string;
  exampleCount: number;
  sample: string | null;
};

export type PersonaBaseline = {
  slug: string;
  name: string;
  version: number;
  provenance: {
    sourceCount: number | null;
    confidence: string | null;
    extractionDate: string | null;
    episodeCount: number | null;
  };
  fingerprint: VoiceFingerprint | null;
  style: { tone: string | null; habits: string[]; avoid: string[] };
  language: {
    acknowledgmentsStrong: string[];
    acknowledgmentsWeak: string[];
    bridges: string[];
    fillerWords: string[];
    questionStyle: string | null;
    sentenceLength: string | null;
  };
  decisionPolicy: DecisionPolicyRow[];
  calibration: {
    firmness_on_weak_answer: number | null;
    patience_with_confusion: number | null;
    warmth_on_strong_answer: number | null;
    preamble_before_question: string | null;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Example entries are usually strings; some are { context: question } objects. */
function sampleLine(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  const record = asRecord(entry);
  const [key, value] = Object.entries(record)[0] ?? [];
  if (typeof value === "string") return key ? `${key} — ${value}` : value;
  if (typeof key === "string") return key;
  return null;
}

export async function getPersonaBaseline(orgId: string, slug: string): Promise<PersonaBaseline | null> {
  const persona = await db.persona.findUnique({
    where: { orgId_slug: { orgId, slug } },
    select: { id: true, name: true, version: true, data: true },
  });
  if (!persona) return null;

  const data = asRecord(persona.data);
  const style = asRecord(data.style);
  const language = asRecord(data.language);
  const acknowledgments = asRecord(language.acknowledgments);
  const examples = asRecord(data.examples);
  const preferences = asRecord(data.decision_preferences);
  const calibration = asRecord(data.calibration);
  const sourceEvidence = asRecord(data.source_evidence);

  // Enforced voice fingerprint from the real spoken corpus. Degrade gracefully
  // when the vector index is unavailable (e.g. Chroma down / not reindexed).
  let fingerprint: VoiceFingerprint | null = null;
  try {
    const stats = await MainCollectionService.getPersonaPrimerStats(orgId, persona.id);
    fingerprint = stats.turns > 0 ? stats : null;
  } catch {
    fingerprint = null;
  }

  const decisionPolicy: DecisionPolicyRow[] = Object.entries(preferences)
    .filter(([, move]) => typeof move === "string")
    .map(([state, move]) => {
      const list = Array.isArray(examples[move as string]) ? (examples[move as string] as unknown[]) : [];
      return {
        state,
        move: move as string,
        exampleCount: list.length,
        sample: list.length ? sampleLine(list[0]) : null,
      };
    });

  return {
    slug,
    name: persona.name,
    version: persona.version,
    provenance: {
      sourceCount: asNumber(sourceEvidence.source_count),
      confidence: asString(sourceEvidence.confidence),
      extractionDate: asString(sourceEvidence.extraction_date),
      episodeCount: fingerprint ? fingerprint.turns : null,
    },
    fingerprint,
    style: {
      tone: asString(style.tone),
      habits: asStringArray(style.habits),
      avoid: asStringArray(style.avoid),
    },
    language: {
      acknowledgmentsStrong: asStringArray(acknowledgments.strong),
      acknowledgmentsWeak: asStringArray(acknowledgments.weak),
      bridges: asStringArray(language.bridges),
      fillerWords: asStringArray(language.filler_words),
      questionStyle: asString(language.question_style),
      sentenceLength: asString(language.sentence_length),
    },
    decisionPolicy,
    calibration: {
      firmness_on_weak_answer: asNumber(calibration.firmness_on_weak_answer),
      patience_with_confusion: asNumber(calibration.patience_with_confusion),
      warmth_on_strong_answer: asNumber(calibration.warmth_on_strong_answer),
      preamble_before_question: asString(calibration.preamble_before_question),
    },
  };
}
