import { z } from "zod";

/**
 * Client personas: the people a learner speaks with in a role play. Stored as
 * Persona rows whose data has `kind: "client"`. Option values are stored in
 * lower case (as the seed does); the editor shows them title-cased.
 */

export const CLIENT_ROLES = ["Buyer", "Seller", "Landlord", "Investor", "Prospect", "Decision maker", "Customer", "Champion"] as const;
export const BEHAVIOURS = ["Warm & Open", "Warm but Cautious", "Curious & Probing", "Skeptical & Reserved", "Direct & Challenging"] as const;
export const MAX_BEHAVIOURS = 3;
export const MAX_SIGNATURE_PHRASES = 4;

export const PERSONA_DIFFICULTIES = [
  { value: "easy", label: "Easy", description: "Nervous but willing. Opens up quickly once the agent asks a good question." },
  { value: "medium", label: "Medium", description: "Guarded at first. Opens up only when the agent earns it." },
  { value: "hard", label: "Hard", description: "Confident and testing. Impatient with weak or scripted questions." },
  { value: "hardest", label: "Hardest", description: "Hides the real issue. Ends the call quickly after mistakes." },
] as const;
export const OPENING_STYLES = ["friendly", "skeptical", "rushed"] as const;
export const FORMALITY = ["casual", "neutral", "formal"] as const;
export const ANSWER_LENGTH = ["short", "medium", "long"] as const;
export const INTERRUPTS = ["never", "sometimes", "often"] as const;
export const PACE = ["slow", "normal", "fast"] as const;

export const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export type ClientPersonaForm = {
  look: string;
  name: string;
  role: string;
  age: string;
  basedIn: string;
  background: string;
  behaviours: string[];
  difficulty: (typeof PERSONA_DIFFICULTIES)[number]["value"];
  openingStyle: (typeof OPENING_STYLES)[number];
  formality: (typeof FORMALITY)[number];
  answerLength: (typeof ANSWER_LENGTH)[number];
  interrupts: (typeof INTERRUPTS)[number];
  pauses: boolean;
  fillers: boolean;
  phrases: string[];
  howTheyTalk: string;
  voiceId: string;
  pace: (typeof PACE)[number];
  knowledge: { documentIds: string[]; sourceIds: string[] };
};

/** The five ready-made people. Picking one fills the form; everything stays editable. */
export const PERSONA_PRESETS: Array<{ id: string; label: string; avatar: string } & Omit<ClientPersonaForm, "look" | "knowledge">> = [
  {
    id: "daniel", label: "Daniel", avatar: "/roleplay/avatars/daniel.jpg",
    name: "Daniel Whitfield", role: "Buyer", age: "44", basedIn: "London",
    background: "Works in finance operations. Enquired about an off-plan project months ago, then put the idea on hold. Wants to wait for prices to hit the bottom.",
    behaviours: ["Warm but Cautious"], difficulty: "medium", openingStyle: "skeptical",
    formality: "neutral", answerLength: "short", interrupts: "never", pauses: true, fillers: false,
    phrases: ["I’ll wait and see.", "Maybe call me in three months."],
    howTheyTalk: "Polite, a little guarded, slightly tired of sales calls. Short answers at first.",
    voiceId: "oliver-sample", pace: "normal",
  },
  {
    id: "rajesh", label: "Rajesh", avatar: "/roleplay/avatars/rajesh.jpg",
    name: "Rajesh Menon", role: "Landlord", age: "58", basedIn: "Dubai",
    background: "Owns three rental apartments. Did not expect the call and wants to know who gave out the number.",
    behaviours: ["Skeptical & Reserved"], difficulty: "hard", openingStyle: "skeptical",
    formality: "formal", answerLength: "short", interrupts: "sometimes", pauses: false, fillers: false,
    phrases: ["Who gave you my number?", "I’m not selling."],
    howTheyTalk: "Brief and businesslike. Stays on the line only if the agent is short.",
    voiceId: "ethan-sample", pace: "normal",
  },
  {
    id: "claire", label: "Claire", avatar: "/roleplay/avatars/claire.jpg",
    name: "Claire Dunmore", role: "Seller", age: "41", basedIn: "Dubai Marina",
    background: "Selling a two-bedroom apartment. Another agency offered to list it for one percent.",
    behaviours: ["Direct & Challenging"], difficulty: "hard", openingStyle: "skeptical",
    formality: "neutral", answerLength: "medium", interrupts: "sometimes", pauses: true, fillers: false,
    phrases: ["What do I actually get for the higher fee?"],
    howTheyTalk: "Calm and specific. Not angry, but ends the call if the answer sounds like a script.",
    voiceId: "charlotte-sample", pace: "normal",
  },
  {
    id: "elena", label: "Elena", avatar: "/roleplay/avatars/elena.jpg",
    name: "Elena Rossi", role: "Investor", age: "47", basedIn: "Zurich",
    background: "Overseas investor with about two million dirhams and ten minutes. Wants a clear picture before booking anything.",
    behaviours: ["Curious & Probing"], difficulty: "medium", openingStyle: "friendly",
    formality: "formal", answerLength: "medium", interrupts: "never", pauses: true, fillers: false,
    phrases: ["What would you show me?", "Walk me through the numbers."],
    howTheyTalk: "Measured and precise. Asks for numbers and timelines.",
    voiceId: "priya-sample", pace: "normal",
  },
  {
    id: "marcus", label: "Marcus", avatar: "/roleplay/avatars/marcus.jpg",
    name: "Marcus Reid", role: "Buyer", age: "34", basedIn: "Manchester",
    background: "First-time buyer who went quiet after a viewing. Needs one clear next step.",
    behaviours: ["Warm & Open"], difficulty: "easy", openingStyle: "friendly",
    formality: "casual", answerLength: "short", interrupts: "never", pauses: true, fillers: true,
    phrases: ["I just need to think about it.", "It was nice, to be honest."],
    howTheyTalk: "Friendly but hesitant. Opens up quickly once the agent asks a good question.",
    voiceId: "ethan-sample", pace: "normal",
  },
];

export function presetForm(id: string): ClientPersonaForm {
  const preset = PERSONA_PRESETS.find((item) => item.id === id) ?? PERSONA_PRESETS[0];
  return {
    look: preset.id, name: preset.name, role: preset.role, age: preset.age, basedIn: preset.basedIn,
    background: preset.background, behaviours: [...preset.behaviours], difficulty: preset.difficulty,
    openingStyle: preset.openingStyle, formality: preset.formality, answerLength: preset.answerLength,
    interrupts: preset.interrupts, pauses: preset.pauses, fillers: preset.fillers, phrases: [...preset.phrases],
    howTheyTalk: preset.howTheyTalk, voiceId: preset.voiceId, pace: preset.pace,
    knowledge: { documentIds: [], sourceIds: [] },
  };
}

const pick = <T extends readonly string[]>(options: T, value: unknown, fallback: T[number]): T[number] => {
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (options as readonly string[]).includes(lower) ? (lower as T[number]) : fallback;
};
const str = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** Editor form values from stored persona data. */
export function formFromPersonaData(data: unknown): ClientPersonaForm {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const mannerisms = (record.mannerisms && typeof record.mannerisms === "object" ? record.mannerisms : {}) as Record<string, unknown>;
  const knowledge = (record.knowledge && typeof record.knowledge === "object" ? record.knowledge : {}) as Record<string, unknown>;
  const avatar = str(record.avatar);
  return {
    look: str(record.look) || (PERSONA_PRESETS.find((preset) => preset.avatar === avatar)?.id ?? ""),
    name: str(record.name),
    role: str(record.role) || "Buyer",
    age: str(record.age),
    basedIn: str(record.based_in),
    background: str(record.background),
    behaviours: strings(record.behaviours).slice(0, MAX_BEHAVIOURS),
    difficulty: pick(PERSONA_DIFFICULTIES.map((item) => item.value), record.difficulty, "medium"),
    openingStyle: pick(OPENING_STYLES, record.opening_style, "friendly"),
    formality: pick(FORMALITY, mannerisms.formality, "neutral"),
    answerLength: pick(ANSWER_LENGTH, mannerisms.answer_length, "short"),
    interrupts: pick(INTERRUPTS, mannerisms.interrupts, "never"),
    pauses: mannerisms.pauses === true,
    fillers: mannerisms.fillers === true,
    phrases: strings(record.signature_phrases).slice(0, MAX_SIGNATURE_PHRASES),
    howTheyTalk: str(record.how_they_talk),
    voiceId: str(record.voiceId),
    pace: pick(PACE, record.pace, "normal"),
    knowledge: { documentIds: strings(knowledge.documentIds), sourceIds: strings(knowledge.sourceIds) },
  };
}

export const clientPersonaSchema = z.object({
  look: z.string().max(40).default(""),
  name: z.string().trim().min(1, "Name is required").max(120),
  role: z.string().trim().min(1).max(60),
  age: z.string().trim().max(10).default(""),
  basedIn: z.string().trim().max(120).default(""),
  background: z.string().trim().max(2000).default(""),
  behaviours: z.array(z.enum(BEHAVIOURS)).max(MAX_BEHAVIOURS, "Pick up to three behaviours"),
  difficulty: z.enum(["easy", "medium", "hard", "hardest"]),
  openingStyle: z.enum(OPENING_STYLES),
  formality: z.enum(FORMALITY),
  answerLength: z.enum(ANSWER_LENGTH),
  interrupts: z.enum(INTERRUPTS),
  pauses: z.boolean(),
  fillers: z.boolean(),
  phrases: z.array(z.string().trim().min(1).max(200)).max(MAX_SIGNATURE_PHRASES, "Four signature phrases at most"),
  howTheyTalk: z.string().trim().max(2000).default(""),
  voiceId: z.string().max(128).default(""),
  pace: z.enum(PACE),
  knowledge: z.object({
    documentIds: z.array(z.string().max(128)).max(200).default([]),
    sourceIds: z.array(z.string().max(128)).max(50).default([]),
  }),
});

/** Stored persona data (the shape the seed and the brain read). */
export function personaDataFromForm(form: z.infer<typeof clientPersonaSchema>, existing: Record<string, unknown> = {}) {
  const preset = PERSONA_PRESETS.find((item) => item.id === form.look);
  const age = Number(form.age);
  return {
    ...existing,
    kind: "client",
    look: form.look || undefined,
    name: form.name,
    role: form.role,
    age: Number.isFinite(age) && form.age ? age : form.age || undefined,
    based_in: form.basedIn || undefined,
    background: form.background || undefined,
    behaviours: form.behaviours,
    difficulty: form.difficulty,
    opening_style: form.openingStyle,
    how_they_talk: form.howTheyTalk || undefined,
    mannerisms: {
      formality: form.formality,
      answer_length: form.answerLength,
      interrupts: form.interrupts,
      pauses: form.pauses,
      fillers: form.fillers,
    },
    signature_phrases: form.phrases,
    avatar: preset?.avatar ?? existing.avatar,
    voiceId: form.voiceId || undefined,
    pace: form.pace,
    knowledge: form.knowledge,
  };
}

/** Short speaking tags for a persona card, e.g. "Polite", "Short answers". */
export function speakingTags(form: ClientPersonaForm): string[] {
  const tags = [titleCase(form.formality)];
  if (form.answerLength === "short") tags.push("Short answers");
  else if (form.answerLength === "long") tags.push("Long answers");
  if (form.interrupts !== "never") tags.push(`Interrupts ${form.interrupts}`);
  return tags;
}
