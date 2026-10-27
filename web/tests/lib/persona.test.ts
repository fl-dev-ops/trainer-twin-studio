import { beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyPersona, personaFromStored, personaInputSchema, speakingTags, storedFromPersona, type PersonaInput } from "@/lib/persona";

// Role-play persona model: prompt fields in Persona.data (brain shape), pace in Persona.settings.
// No knowledge and no difficulty (the role play owns both).

const amira: PersonaInput = {
  name: "Amira Haddad", role: "Buyer", age: 34, basedIn: "JLT", background: "Went quiet after a viewing.",
  behaviours: ["Warm & Open"], openingStyle: "friendly", formality: "casual", answerLength: "long", interrupts: "never",
  pauses: true, fillers: true, phrases: ["I need to talk to my husband."], howTheyTalk: "Chatty and warm.", pace: "normal",
};

test("stored shape round-trips and drops difficulty and knowledge", () => {
  const stored = storedFromPersona("amira", amira, { difficulty: "hard", knowledge: { documentIds: ["x"] }, extra: "kept" });
  expect(stored.data).toMatchObject({ id: "amira", role: "Buyer", based_in: "JLT", mannerisms: { formality: "casual", answer_length: "long" }, extra: "kept" });
  expect("difficulty" in stored.data || "knowledge" in stored.data).toBe(false);
  expect(stored.settings).toEqual({ pace: "normal" });
  expect(personaFromStored("Amira Haddad", stored.data, stored.settings)).toEqual(amira);
});

test("reads every seeded preset file the way the seed stores it", () => {
  for (const file of ["olga/buyer-quiet-after-viewing", "olga/landlord-unexpected-call", "vasanth/senior-engineer-depth-probe"]) {
    const preset = JSON.parse(readFileSync(join(import.meta.dir, "../../data/personas/presets", `${file}.json`), "utf8"));
    const p = preset.prompt;
    const data = { id: preset.slug, name: preset.name, role: p.role, age: p.age, based_in: p.based_in, background: p.background, behaviours: p.behaviours, opening_style: p.opening_style, how_they_talk: p.how_they_talk, mannerisms: { formality: p.formality, answer_length: p.answer_length, interrupts: p.interrupts, pauses: p.pauses, fillers: p.fillers }, signature_phrases: p.signature_phrases };
    const read = personaFromStored(preset.name, data, preset.program);
    expect(personaInputSchema.safeParse(read).success).toBe(true);
    expect(read).toMatchObject({ name: preset.name, role: p.role, age: p.age, behaviours: p.behaviours, phrases: p.signature_phrases, pace: preset.program.pace });
  }
});

test("validation: name, 1-3 known behaviours, known options, adult age, at most 4 phrases", () => {
  const bad = (patch: Partial<PersonaInput>) => personaInputSchema.safeParse({ ...amira, ...patch }).success;
  expect(bad({})).toBe(true);
  expect(bad({ name: " " })).toBe(false);
  expect(bad({ behaviours: [] })).toBe(false);
  expect(bad({ behaviours: ["Warm & Open", "Warm but Cautious", "Curious & Probing", "Skeptical & Reserved"] })).toBe(false);
  expect(bad({ formality: "slangy" as never })).toBe(false);
  expect(bad({ age: 12 })).toBe(false);
  expect(bad({ age: null })).toBe(true);
  expect(bad({ phrases: ["a", "b", "c", "d", "e"] })).toBe(false);
  expect(personaInputSchema.safeParse({ ...amira, difficulty: "hard" }).success).toBe(false);
});

test("speaking tags summarise how they talk", () => {
  expect(speakingTags(amira)).toEqual(["Casual", "Long answers", "Pauses", "Fillers"]);
  expect(speakingTags({ ...emptyPersona(), interrupts: "often" })).toEqual(["Neutral", "Interrupts often"]);
});

// ---- savePersona -----------------------------------------------------------------------------------------------
type Row = { id: string; orgId: string; slug: string; name: string; version: number; data: unknown; settings: unknown; isOwn: boolean };
let rows: Row[];
let versions: unknown[];
mock.module("@/lib/db", () => ({
  db: {
    persona: {
      findFirst: async ({ where }: { where: { orgId: string; slug: string } }) => rows.find((r) => r.orgId === where.orgId && r.slug === where.slug) ?? null,
      create: async ({ data }: { data: Omit<Row, "id"> }) => { const row = { id: `p${rows.length}`, ...data }; rows.push(row); return row; },
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
    },
    specVersion: { create: ({ data }: { data: unknown }) => versions.push(data) },
    $transaction: async (ops: unknown[]) => ops,
  },
}));
const { PersonaError, savePersona } = await import("@/lib/personas");

beforeEach(() => {
  rows = [{ id: "own", orgId: "o1", slug: "olga", name: "Olga", version: 1, data: {}, settings: null, isOwn: true }];
  versions = [];
});

test("creating makes a role-play persona (isOwn false) with a unique slug", async () => {
  const first = await savePersona("o1", amira);
  const second = await savePersona("o1", amira);
  expect([first.slug, second.slug]).toEqual(["amira-haddad", "amira-haddad-2"]);
  expect(rows.filter((r) => r.slug.startsWith("amira")).every((r) => r.isOwn === false && r.version === 1)).toBe(true);
  // Never clashes with a trainer's own persona.
  rows[0].slug = "olga";
  expect((await savePersona("o1", { ...amira, name: "Olga" })).slug).toBe("olga-2");
});

test("updating is versioned and never touches someone's own persona", async () => {
  const { slug } = await savePersona("o1", amira);
  const updated = await savePersona("o1", { ...amira, formality: "formal", pace: "slow" }, slug);
  expect(updated.version).toBe(2);
  expect(versions).toHaveLength(1);
  const row = rows.find((r) => r.slug === slug)!;
  expect(row.settings).toEqual({ pace: "slow" });
  expect((row.data as { mannerisms: { formality: string } }).mannerisms.formality).toBe("formal");
  await expect(savePersona("o1", amira, "olga")).rejects.toBeInstanceOf(PersonaError);
  await expect(savePersona("o2", amira, slug)).rejects.toThrow(/not found/);
  await expect(savePersona("o1", { ...amira, behaviours: [] }, slug)).rejects.toThrow(/behaviour/);
});
