import { z } from "zod";

/**
 * Persona as a role play uses it: the character a learner talks to. Usually a role-play persona (isOwn = false); the
 * trainer's own persona (isOwn = true) can take part too (e.g. as the manager), keeping its own voice and photo. Persona = voice + avatar (own rows,
 * lib/persona-media) + these prompt fields (Persona.data) + program settings (Persona.settings).
 * No knowledge (the role play owns it) and no difficulty (the role play owns it). See plans/persona-fields.md.
 * Client-safe: no server imports.
 */

export const PERSONA_ROLES = {
  Clients: ["Buyer", "Seller", "Landlord", "Investor", "Prospect", "Tenant"],
  Interviewers: ["Technical interviewer", "Senior engineer", "Engineering manager", "Hiring manager"],
  // The trainer's own persona in a role play (e.g. Olga as the manager reviewing an agent).
  Coaches: ["Sales coach", "Sales manager", "Mentor", "Senior agent"],
} as const;
export const ALL_ROLES: string[] = Object.values(PERSONA_ROLES).flat();

/** Each option with the plain meaning the editor shows (and, later, the prompt sends). */
export const BEHAVIOURS = [
  { value: "Warm & Open", meaning: "Friendly and easy to talk to, but still will not decide on this call." },
  { value: "Warm but Cautious", meaning: "Polite and pleasant, yet careful; holds back anything personal until trust is earned." },
  { value: "Curious & Probing", meaning: "Asks pointed questions and wants to understand before sharing." },
  { value: "Skeptical & Reserved", meaning: "Doubts what they hear, gives little away and needs proof before engaging." },
  { value: "Direct & Challenging", meaning: "Blunt and brief; pushes back hard and tests whether the other side knows their stuff." },
] as const;
export const MAX_BEHAVIOURS = 3;
export const MAX_PHRASES = 4;

export const OPENING_STYLES = [
  { value: "friendly", label: "Friendly", meaning: "Answers warmly and is happy enough to take the call." },
  { value: "skeptical", label: "Skeptical", meaning: "Guarded; wants to know who is calling and why before giving any time." },
  { value: "rushed", label: "Rushed", meaning: "Busy; says there is little time and wants the point quickly." },
] as const;
export const FORMALITY = [
  { value: "casual", label: "Casual", meaning: "Relaxed, everyday language: contractions, first names, no business phrasing." },
  { value: "neutral", label: "Neutral", meaning: "Polite, plain conversational language; neither chatty nor stiff." },
  { value: "formal", label: "Formal", meaning: "Polished and businesslike; complete sentences, keeps a professional distance." },
] as const;
export const ANSWER_LENGTH = [
  { value: "short", label: "Short", meaning: "A few words or one sentence; makes the other side ask follow-ups." },
  { value: "medium", label: "Medium", meaning: "One or two sentences; answers with a little context." },
  { value: "long", label: "Long", meaning: "Three to four sentences; shares context and small stories." },
] as const;
export const INTERRUPTS = [
  { value: "never", label: "Never", meaning: "Always lets the other person finish." },
  { value: "sometimes", label: "Sometimes", meaning: "Cuts in now and then, when the other side rambles or repeats a pitch." },
  { value: "often", label: "Often", meaning: "Cuts in regularly; impatient with long or scripted explanations." },
] as const;
export const PACE = [
  { value: "slow", label: "Slow", meaning: "Unhurried; few words, deliberate." },
  { value: "normal", label: "Normal", meaning: "Ordinary conversational speed." },
  { value: "fast", label: "Fast", meaning: "Quick and clipped; moves on fast." },
] as const;

const values = <T extends readonly { value: string }[]>(options: T) => options.map((option) => option.value) as [T[number]["value"], ...T[number]["value"][]];

/** Editor input and the validated shape before it is stored. */
export const personaInputSchema = z.object({
  name: z.string().trim().min(1, "Add a name").max(120),
  role: z.string().trim().min(1, "Pick a role").max(60),
  age: z.number().int().min(18, "Age must be 18 or more").max(100).nullable(),
  basedIn: z.string().trim().max(120),
  background: z.string().trim().max(2000),
  behaviours: z.array(z.enum(values(BEHAVIOURS))).min(1, "Pick at least one behaviour").max(MAX_BEHAVIOURS, "Pick up to three behaviours"),
  openingStyle: z.enum(values(OPENING_STYLES)),
  formality: z.enum(values(FORMALITY)),
  answerLength: z.enum(values(ANSWER_LENGTH)),
  interrupts: z.enum(values(INTERRUPTS)),
  pauses: z.boolean(),
  fillers: z.boolean(),
  phrases: z.array(z.string().trim().min(1).max(200)).max(MAX_PHRASES, "Four signature phrases at most"),
  howTheyTalk: z.string().trim().max(2000),
  pace: z.enum(values(PACE)),
}).strict();
export type PersonaInput = z.infer<typeof personaInputSchema>;

export const emptyPersona = (): PersonaInput => ({
  name: "", role: "Buyer", age: null, basedIn: "", background: "", behaviours: [], openingStyle: "friendly",
  formality: "neutral", answerLength: "medium", interrupts: "never", pauses: false, fillers: false, phrases: [], howTheyTalk: "", pace: "normal",
});

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const pick = <T extends string>(options: readonly { value: T }[], value: unknown, fallback: T): T =>
  options.find((option) => option.value === text(value).toLowerCase())?.value ?? fallback;

/** Editor values from stored Persona.data + Persona.settings (tolerant of older shapes). */
export function personaFromStored(name: string, data: unknown, settings: unknown): PersonaInput {
  const d = asRecord(data);
  const m = asRecord(d.mannerisms);
  const age = typeof d.age === "number" ? d.age : Number.parseInt(text(d.age), 10);
  return {
    name: text(d.name) || name,
    role: text(d.role) || "Buyer",
    age: Number.isFinite(age) ? age : null,
    basedIn: text(d.based_in),
    background: text(d.background),
    behaviours: (Array.isArray(d.behaviours) ? d.behaviours : []).map((b) => BEHAVIOURS.find((x) => x.value.toLowerCase() === text(b).toLowerCase())?.value).filter((b): b is PersonaInput["behaviours"][number] => Boolean(b)).slice(0, MAX_BEHAVIOURS),
    openingStyle: pick(OPENING_STYLES, d.opening_style, "friendly"),
    formality: pick(FORMALITY, m.formality, "neutral"),
    answerLength: pick(ANSWER_LENGTH, m.answer_length, "medium"),
    interrupts: pick(INTERRUPTS, m.interrupts, "never"),
    pauses: m.pauses === true,
    fillers: m.fillers === true,
    phrases: (Array.isArray(d.signature_phrases) ? d.signature_phrases : []).map(text).filter(Boolean).slice(0, MAX_PHRASES),
    howTheyTalk: text(d.how_they_talk),
    pace: pick(PACE, asRecord(settings).pace, "normal"),
  };
}

/** Persona.data (prompt fields, the shape the role-play brain reads) and Persona.settings (program) from input. */
export function storedFromPersona(slug: string, input: PersonaInput, existing: unknown = {}) {
  const data = {
    ...asRecord(existing),
    id: slug,
    name: input.name,
    role: input.role,
    age: input.age ?? undefined,
    based_in: input.basedIn || undefined,
    background: input.background || undefined,
    behaviours: input.behaviours,
    opening_style: input.openingStyle,
    how_they_talk: input.howTheyTalk || undefined,
    mannerisms: { formality: input.formality, answer_length: input.answerLength, interrupts: input.interrupts, pauses: input.pauses, fillers: input.fillers },
    signature_phrases: input.phrases,
  };
  delete (data as Record<string, unknown>).difficulty; // owned by the role play now
  delete (data as Record<string, unknown>).knowledge; // owned by the role play now
  return { data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>, settings: { pace: input.pace } };
}

const label = (options: readonly { value: string; label: string }[], value: string) => options.find((o) => o.value === value)?.label ?? value;

/** Short "how they talk" tags for cards, e.g. "Formal", "Short answers", "Interrupts often". */
export function speakingTags(p: PersonaInput): string[] {
  const tags = [label(FORMALITY, p.formality)];
  if (p.answerLength !== "medium") tags.push(`${label(ANSWER_LENGTH, p.answerLength)} answers`);
  if (p.interrupts !== "never") tags.push(`Interrupts ${p.interrupts}`);
  if (p.pauses) tags.push("Pauses");
  if (p.fillers) tags.push("Fillers");
  return tags;
}

export const optionLabel = label;
export const meaningOf = (options: readonly { value: string; meaning: string }[], value: string) => options.find((o) => o.value === value)?.meaning ?? "";

export const slugify = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "persona";

/**
 * The persona as prompt lines for the chat brain (plans/persona-in-chat.md), from stored Persona.data.
 * "character": a role-play persona the AI plays; the full brief, using each option's meaning.
 * "self": the trainer's own persona (isOwn). Identity only: her voice is the cloned voice and her behaviour comes from
 * her ingested skills, so manner fields would only conflict with them.
 * Null for data without the editor's shape (e.g. global interview personas), so chat keeps its older line.
 */
export function personaBrief(data: unknown, as: "character" | "self"): string | null {
  const d = asRecord(data);
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const role = text(d.role);
  if (!role) return null;
  const meaning = (options: readonly { value: string; meaning: string }[], value: unknown) => options.find((o) => o.value === value)?.meaning;
  const basedIn = text(d.based_in);
  const who = [text(d.name), role, typeof d.age === "number" ? String(d.age) : undefined, basedIn && `based in ${basedIn}`].filter(Boolean).join(", ");
  const lines = [`- Who: ${who}.`];
  const background = text(d.background);
  if (background) lines.push(`- Background: ${background}`);
  if (as === "self") return lines.join("\n");

  const behaviours = (Array.isArray(d.behaviours) ? d.behaviours : [])
    .map((value) => (meaning(BEHAVIOURS, value) ? `${value}: ${meaning(BEHAVIOURS, value)}` : undefined))
    .filter(Boolean);
  if (behaviours.length) lines.push(`- Personality: ${behaviours.join(" ")}`);
  const opening = meaning(OPENING_STYLES, d.opening_style);
  if (opening) lines.push(`- When the conversation opens: ${opening}`);
  const m = asRecord(d.mannerisms);
  const manner = [
    meaning(FORMALITY, m.formality),
    meaning(ANSWER_LENGTH, m.answer_length),
    meaning(INTERRUPTS, m.interrupts),
    m.pauses === true ? "Pauses to think before answering." : undefined,
    m.fillers === true ? "Uses everyday fillers (um, well, you know)." : undefined,
  ].filter(Boolean);
  if (manner.length) lines.push(`- How they talk: ${manner.join(" ")}`);
  const ownWords = text(d.how_they_talk);
  if (ownWords) lines.push(`- In their own words: ${ownWords}`);
  const phrases = (Array.isArray(d.signature_phrases) ? d.signature_phrases : []).map(text).filter(Boolean);
  if (phrases.length) lines.push(`- Lines they come back to, in their own words and not every turn: ${phrases.map((p) => `"${p}"`).join(", ")}`);
  lines.push("- Stay in character. This person decides HOW you speak (length, tone, phrases); the scenario or skill decides WHAT you do (steps, rules).");
  return lines.join("\n");
}
