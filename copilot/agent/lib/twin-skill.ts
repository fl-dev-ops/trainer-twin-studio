// Twin skills (twin-creator): the trainer's knowledge, decisions, patterns and approach on one topic, extracted from
// their material. The trainer's twin uses one to advise a learner on a real situation. NOT a role play: no learner
// part, no practice script, no trainer/learner moves. Role plays are roleplay-creator (lib/ingest.ts).
//
// Files, under output/<user>/twin-skills/<id>/:
//   SKILL.md     the skill, first person, the TWIN_SKILL_SECTIONS
//   skill.json   { skill, name, description, situations }
//   items.json   the trainer's own words only, each tagged with a situation and a kind
//   patterns.md  the evidence notes behind SKILL.md, with [[file#turn]] refs
//   sources.json work file (not published): which speaker labels are the trainer in two-person recordings
import { createHash } from "node:crypto";
import { z } from "zod";
import { addNames, ensureSynced, type InventoryFile, knownNames, leaks, readSourceText, redactor, REF, resolveSource, words } from "./ingest";
import { type Io, outPath, readJson } from "./paths";
import { parseDoc } from "./turns";

// shortcut: fixed bars like roleplay-creator's; tune per trainer after the first runs.
export const TWIN = {
  minSources: 3, // distinct files the items come from
  minItemsPerSituation: 3,
  maxItemsPerSituation: 25,
  minDecisions: 3, // items of kind "decision": a twin skill is judgment, not only facts
  minItemWords: 6,
  situations: { min: 2, max: 6 },
  maxWords: { skill: 2000, patterns: 2000, context: 25 },
  minFirstPerson: 8, // "I", "my", "me" in SKILL.md: it is written as the trainer
  minDecisionRules: 3, // bullets under "## How I decide"
} as const;
export const TWIN_SKILL_SECTIONS = ["## Topic", "## What I know", "## How I decide", "## Patterns I see", "## My approach", "## What I say", "## Gaps"];
export const TWIN_PATTERN_SECTIONS = ["## What I know", "## How I decide", "## Patterns I see", "## My approach", "## What I say", "## Gaps"];
export const ITEM_KINDS = ["knowledge", "decision", "pattern", "approach", "phrasing"] as const;
// Role-play structure that has no place in a twin skill.
const ROLEPLAY_MARKERS = ["## Playing the learner side", "## Roles", "## Steps", "## How a session runs", "trainer_moves", "learner_moves"];
const TWIN_FILES = ["SKILL.md", "skill.json", "items.json", "patterns.md"];

export const twinDir = (id: string) => `twin-skills/${id}`;
const kebab = z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case, at most 64 characters");

export const twinSkillHead = z.object({
  skill: kebab.describe("The skill id."),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1024).regex(/^[^<>]+$/, "description cannot contain angle brackets")
    .describe("When the twin should use this skill: the topic and the situations a learner brings."),
  situations: z.array(z.object({ id: kebab, name: z.string().trim().min(1).max(120) }))
    .min(TWIN.situations.min).max(TWIN.situations.max)
    .describe("The kinds of real situation a learner brings that this skill answers, e.g. 'buyer-waits-for-prices'."),
});
export type TwinSkillHead = z.infer<typeof twinSkillHead>;

export const twinItemInput = z.object({
  source: z.string().describe("File id from `files`."),
  n: z.number().int().optional().describe("Turn number, for recordings."),
  quote: z.string().optional().describe("Exact text copied from a doc or post."),
  start: z.string().optional().describe("Optional exact first words of the relevant part of the turn."),
  end: z.string().optional().describe("Optional exact last words of that part. Omit both to keep the whole turn."),
  situation: z.string().describe("One of the skill's situation ids."),
  kind: z.enum(ITEM_KINDS).describe("knowledge: a fact or principle; decision: a judgment call and why; pattern: a recurring situation and what it means; approach: how the trainer handles it; phrasing: how the trainer says it."),
  context: z.string().describe(`What this passage is about or answers, in at most ${TWIN.maxWords.context} words. No personal details.`),
});
export type TwinItemInput = z.infer<typeof twinItemInput>;
/** Stored shape; `step` carries the situation, so retrieval filters by situation like a playbook step. */
export type TwinItem = {
  id: string; role: "trainer"; context: string; text: string;
  metadata: { skill_id: string; step: string; type: (typeof ITEM_KINDS)[number]; source: string; kind: "session" | "doc"; ref: number | null; words: number };
};
/** Two-person recordings: the speaker labels that are the trainer. Solo recordings need none. */
export const trainerLabels = z.record(z.string(), z.array(z.string()).min(1));

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const linesUnder = (text: string, heading: string) => {
  const i = text.indexOf(heading);
  if (i < 0) return [];
  const rest = text.slice(i + heading.length);
  const j = rest.search(/\n## /);
  return (j < 0 ? rest : rest.slice(0, j)).split("\n");
};
const bullets = (lines: string[]) => lines.filter((l) => /^\s*[-*] /.test(l));
export const twinSkillHeader = (head: TwinSkillHead) => `---\nname: ${head.skill}\ndescription: ${JSON.stringify(head.description)}\n---\n`;

/** Builds items from the sources: only the trainer's own words, copied exactly. */
export async function makeTwinItems(io: Io, user: string, head: TwinSkillHead, trainer: Record<string, string[]>, picks: TwinItemInput[]) {
  const inv = await ensureSynced(io, user);
  const redact = redactor(await knownNames(io, user));
  const situations = new Set(head.situations.map((s) => s.id));
  const texts = new Map<string, string>();
  const items: TwinItem[] = [];
  const errors: string[] = [];
  for (const [i, p] of picks.entries()) {
    const bad = (why: string) => errors.push(`#${i} ${p.kind} (${p.source}${p.n != null ? `#${p.n}` : ""}): ${why}`);
    let f: InventoryFile;
    try { const rel = resolveSource(inv, p.source); f = inv.find((x) => x.path === rel)!; } catch (e) { bad((e as Error).message); continue; }
    if (!situations.has(p.situation)) { bad(`situation "${p.situation}" is not one of ${[...situations].join(", ")}`); continue; }
    const context = redact(p.context.trim());
    if (!context) { bad("context is empty"); continue; }
    if (words(context) > TWIN.maxWords.context) { bad(`context has ${words(context)} words; keep it under ${TWIN.maxWords.context}`); continue; }
    if (!texts.has(f.path)) texts.set(f.path, (await readSourceText(io, user, inv, f.path)).text);
    const raw = texts.get(f.path)!;
    let text: string;
    let span: number | null = null;
    if (f.kind === "media") {
      if (p.quote) { bad("recordings use n (a turn), not quote"); continue; }
      const t = p.n == null ? undefined : parseDoc(raw).turns[p.n];
      if (!t) { bad("needs a turn number n from the transcript"); continue; }
      const labels = Object.keys(f.speakers ?? {});
      const mine = labels.length <= 1 ? labels : trainer[f.id];
      if (!mine?.length) { bad(`a recording with speakers ${labels.join(", ")}: list the trainer's labels for ${f.id} in \`trainer\``); continue; }
      if (mine.some((l) => !labels.includes(l))) { bad(`trainer labels ${mine.join(", ")} are not all speakers of this file (${labels.join(", ")})`); continue; }
      if (!mine.includes(t.speaker)) { bad(`turn ${p.n} is spoken by ${t.speaker}, not the trainer. A twin skill holds only the trainer's own words`); continue; }
      const whole = squash(t.text);
      if (p.start || p.end) {
        const a = p.start ? whole.indexOf(squash(p.start)) : 0;
        if (a < 0) { bad("start is not in this turn; copy its first words exactly"); continue; }
        const e = p.end ? whole.indexOf(squash(p.end), a) : -1;
        if (p.end && e < 0) { bad("end is not in this turn after start; copy its last words exactly"); continue; }
        text = redact(whole.slice(a, p.end ? e + squash(p.end).length : whole.length).trim());
        span = text === redact(whole) ? null : a;
      } else text = redact(t.text);
    } else {
      // Docs and posts are the trainer's own writing.
      if (p.n != null) { bad("docs and posts use quote, not n"); continue; }
      if (!p.quote || !(squash(raw).includes(squash(p.quote)) || squash(redact(raw)).includes(squash(p.quote)))) { bad("quote must be copied exactly from the file"); continue; }
      text = redact(squash(p.quote));
    }
    const n = words(text);
    if (n < TWIN.minItemWords) { bad(`"${text}" has ${n} words; skip fillers under ${TWIN.minItemWords} words`); continue; }
    const ref = f.kind === "media" ? p.n! : null;
    const key = ref != null ? (span != null ? `${ref}@${span}` : `${ref}`) : `q${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
    items.push({ id: `${head.skill}/${f.id}#${key}`, role: "trainer", context, text,
      metadata: { skill_id: head.skill, step: p.situation, type: p.kind, source: f.id, kind: f.kind === "media" ? "session" : "doc", ref, words: n } });
  }
  return { items, errors };
}

/** Every rule a twin skill must meet; the build tool and publication both run it. */
export async function checkTwinSkill(io: Io, user: string, id: string) {
  const dir = outPath(user, twinDir(id));
  const reasons: string[] = [];
  const text = await io.read(`${dir}/SKILL.md`);
  const headRaw = await readJson<unknown>(io, user, `${twinDir(id)}/skill.json`, null);
  const patterns = await io.read(`${dir}/patterns.md`);
  const items = await readJson<TwinItem[] | null>(io, user, `${twinDir(id)}/items.json`, null);
  const { trainer } = await readJson(io, user, `${twinDir(id)}/sources.json`, { trainer: {} as Record<string, string[]> });
  for (const [name, value] of [["SKILL.md", text], ["skill.json", headRaw], ["patterns.md", patterns], ["items.json", items]] as const)
    if (value == null) reasons.push(`${name} is missing`);
  if (reasons.length) return { pass: false, reasons };
  const parsed = twinSkillHead.safeParse(headRaw);
  if (!parsed.success) return { pass: false, reasons: [`skill.json: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`] };
  const head = parsed.data;
  if (head.skill !== id) reasons.push(`skill.json skill is "${head.skill}", not "${id}"`);
  const ids = head.situations.map((s) => s.id);
  if (new Set(ids).size !== ids.length) reasons.push("situation ids must be unique");

  // SKILL.md: the trainer's judgment on one topic, in their own voice; nothing of a role play.
  if (!text!.startsWith(twinSkillHeader(head))) reasons.push("SKILL.md needs the name/description header build_twin_skill generates, matching skill.json");
  const body = text!.slice(twinSkillHeader(head).length);
  reasons.push(...TWIN_SKILL_SECTIONS.filter((h) => !body.includes(h)).map((h) => `SKILL.md: missing section "${h}"`));
  const marker = ROLEPLAY_MARKERS.filter((m) => body.includes(m));
  if (marker.length) reasons.push(`SKILL.md has role-play structure (${marker.join(", ")}). A twin skill is not a role play: no roles, steps, moves or learner part`);
  const n = words(body);
  if (n > TWIN.maxWords.skill) reasons.push(`SKILL.md has ${n} words, ${n - TWIN.maxWords.skill} over ${TWIN.maxWords.skill}`);
  if ([...body.matchAll(REF)].length) reasons.push("SKILL.md holds [[refs]]; remove them, the evidence stays in patterns.md");
  const firstPerson = (body.match(/\b(I|I'm|I've|I'd|I'll|my|me)\b/g) ?? []).length;
  if (firstPerson < TWIN.minFirstPerson) reasons.push(`SKILL.md uses the first person ${firstPerson} times; write it as the trainer ("I…", "my…"), not about them`);
  if (/\bthe trainer\b/i.test(body)) reasons.push('SKILL.md says "the trainer"; write as the trainer, in the first person');
  const rules = bullets(linesUnder(body, "## How I decide"));
  if (rules.length < TWIN.minDecisionRules) reasons.push(`"## How I decide" has ${rules.length} rules; it needs at least ${TWIN.minDecisionRules}, each "when …, I … because …"`);
  for (const rule of rules) if (!/\b(when|if|unless|once|before|after|until|as soon as)\b/i.test(rule)) reasons.push(`decision rule "${rule.trim().slice(0, 90)}" needs its condition: "when …" or "if …"`);
  const topic = linesUnder(body, "## Topic").join("\n").toLowerCase();
  for (const s of head.situations) if (!topic.includes(s.name.toLowerCase())) reasons.push(`"## Topic" should name the situation "${s.name}"`);

  // patterns.md: every observation cites the trainer's material.
  reasons.push(...TWIN_PATTERN_SECTIONS.filter((h) => !patterns!.includes(h)).map((h) => `patterns.md: missing section "${h}"`));
  const pn = words(patterns!.replace(REF, ""));
  if (pn > TWIN.maxWords.patterns) reasons.push(`patterns.md has ${pn} words without refs, ${pn - TWIN.maxWords.patterns} over ${TWIN.maxWords.patterns}`);
  const sources = new Set(items!.map((x) => x.metadata.source));
  const inv = await ensureSynced(io, user);
  for (const h of TWIN_PATTERN_SECTIONS.filter((x) => x !== "## Gaps"))
    for (const line of bullets(linesUnder(patterns!, h))) {
      const refs = [...line.matchAll(REF)];
      if (!refs.length) reasons.push(`patterns.md bullet under "${h}" cites nothing: "${line.trim().slice(0, 90)}"`);
      for (const m of refs) {
        let f: InventoryFile | undefined;
        try { f = inv.find((x) => x.path === resolveSource(inv, m[1])); } catch { /* reported below */ }
        if (!f) reasons.push(`patterns.md: ${m[0]} is not a file`);
        else if (!sources.has(f.id)) reasons.push(`patterns.md: ${m[0]} is not one of this skill's item sources`);
      }
    }

  // items.json: rebuilds from the sources, enough evidence for every situation, judgment and not only facts.
  const picks: TwinItemInput[] = items!.map((x) => ({
    source: x.metadata.source, situation: x.metadata.step, kind: x.metadata.type, context: x.context,
    ...(x.metadata.kind === "doc" ? { quote: x.text } : { n: x.metadata.ref ?? undefined }),
  }));
  const rebuilt = await makeTwinItems(io, user, head, trainer, picks);
  reasons.push(...rebuilt.errors);
  for (const it of items!) if (it.role !== "trainer") reasons.push(`${it.id}: role must be trainer; a twin skill holds only the trainer's words`);
  for (const it of items!) if (!rebuilt.items.some((r) => r.id === it.id && r.text === it.text)) reasons.push(`${it.id}: does not rebuild from its source`);
  const seen = new Map<string, string>();
  for (const it of items!) { const key = squash(it.text).toLowerCase(); if (seen.has(key)) reasons.push(`${it.id} repeats ${seen.get(key)}`); else seen.set(key, it.id); }
  if (sources.size < TWIN.minSources) reasons.push(`items come from ${sources.size} sources; a twin skill needs at least ${TWIN.minSources}. If the material has no more, report it and stop`);
  for (const s of head.situations) {
    const count = items!.filter((x) => x.metadata.step === s.id).length;
    if (count < TWIN.minItemsPerSituation) reasons.push(`situation ${s.id}: ${count} items; it needs ${TWIN.minItemsPerSituation}, or drop the situation`);
    if (count > TWIN.maxItemsPerSituation) reasons.push(`situation ${s.id}: ${count} items, over ${TWIN.maxItemsPerSituation}`);
  }
  const decisions = items!.filter((x) => x.metadata.type === "decision").length;
  if (decisions < TWIN.minDecisions) reasons.push(`${decisions} decision items; a twin skill needs at least ${TWIN.minDecisions} (judgment calls and why)`);

  const names = await knownNames(io, user);
  for (const [file, value] of [["SKILL.md", text!], ["patterns.md", patterns!.replace(REF, "")], ["skill.json", JSON.stringify(head)]] as const) {
    const found = leaks(value, names);
    if (found.length) reasons.push(`${file} holds personal details: ${found.slice(0, 8).join(", ")}. Use roles or [name]`);
  }
  for (const it of items!) { const found = leaks(`${it.text} ${it.context}`, names); if (found.length) reasons.push(`${it.id}: holds personal details (${found.join(", ")})`); }

  const byKind = Object.fromEntries(ITEM_KINDS.map((k) => [k, items!.filter((x) => x.metadata.type === k).length]));
  return { pass: !reasons.length, reasons: [...new Set(reasons)], sources: sources.size, items: items!.length, by_kind: byKind };
}

export const twinBuildInput = z.object({
  user: z.string(),
  skill: twinSkillHead,
  trainer: trainerLabels.default({}).describe("For each two-person recording you take items from: the speaker labels that are the trainer."),
  names: z.array(z.string()).default([]).describe("Names of people and companies you saw, to redact."),
  items: z.array(twinItemInput).min(1),
  patterns: z.string().min(1).describe("patterns.md: the evidence notes, with every section and [[file#turn]] / [[file]] refs."),
  body: z.string().min(1).describe("SKILL.md body (no front matter), first person, every section."),
});

/** Saves every file of one twin skill (replacing an earlier attempt), then runs the full check. Writes nothing if an item is rejected. */
export async function saveTwinSkill(io: Io, user: string, input: z.infer<typeof twinBuildInput>) {
  const { skill: head, trainer, names, items: picks, patterns, body } = input;
  if (body.trimStart().startsWith("---")) return { saved: false, rejected: ["Pass the SKILL.md body without front matter; code creates the header."] };
  if (names.length) await addNames(io, user, `twin:${head.skill}`, names);
  const { items, errors } = await makeTwinItems(io, user, head, trainer, picks);
  if (errors.length) return { saved: false, rejected: errors };
  const redact = redactor(await knownNames(io, user));
  const dir = twinDir(head.skill);
  await io.write(outPath(user, `${dir}/sources.json`), JSON.stringify({ trainer }, null, 1) + "\n");
  await io.write(outPath(user, `${dir}/skill.json`), JSON.stringify(head, null, 2) + "\n");
  await io.write(outPath(user, `${dir}/SKILL.md`), twinSkillHeader(head) + body.trim() + "\n");
  await io.write(outPath(user, `${dir}/patterns.md`), patterns.trim() + "\n");
  await io.write(outPath(user, `${dir}/items.json`), JSON.stringify(items.map((x) => ({ ...x, text: redact(x.text), context: redact(x.context) })), null, 1) + "\n");
  return { saved: true, check: await checkTwinSkill(io, user, head.skill) };
}

/** The files to publish for one twin skill, checked against a frozen snapshot; nothing is sent when the check fails. */
export async function prepareTwinPublication(io: Io, user: string, id: string) {
  const dir = outPath(user, twinDir(id));
  const paths = [...TWIN_FILES.map((f) => `${dir}/${f}`), `${dir}/sources.json`, outPath(user, "report.md")];
  const snapshot = new Map(await Promise.all(paths.map(async (p) => [p, await io.read(p)] as const)));
  const frozen: Io = { ...io, read: async (p) => (snapshot.has(p) ? snapshot.get(p) ?? null : io.read(p)) };
  const result = await checkTwinSkill(frozen, user, id);
  if (!result.pass) return { files: [], rejected: result.reasons };
  const files = TWIN_FILES.map((f) => ({ path: `${twinDir(id)}/${f}`, text: snapshot.get(`${dir}/${f}`)! }));
  const report = snapshot.get(outPath(user, "report.md"));
  if (report != null) {
    if (leaks(report, await knownNames(io, user)).length) return { files: [], rejected: ["report.md contains personal details; redact it before publishing"] };
    files.push({ path: "report.md", text: report });
  }
  return { files, rejected: [] };
}

export function twinRequirementsText() {
  return `# Requirements build_twin_skill and publish_twin_skill enforce

Know these before you read anything. Every number is a hard limit in code.

## skill.json (\`skill\`)
- \`skill\`: kebab-case id, at most 64 characters. \`description\`: when the twin should use this skill, at most 1024 characters, no angle brackets.
- ${TWIN.situations.min} to ${TWIN.situations.max} \`situations\`: the kinds of real situation a learner brings that this skill answers, each a kebab-case \`id\` and a \`name\`.

## Items (the trainer's own words)
- Only the trainer's words. A recording with one speaker is the trainer. For a two-person recording, list the trainer's speaker labels in \`trainer\` ({ "<file id>": ["speaker_1"] }); a turn by anyone else is rejected. Docs and posts: \`quote\` copied exactly.
- Each item: \`source\` (file id), \`n\` (turn, recordings) or \`quote\` (docs), optional exact \`start\`/\`end\`, \`situation\` (a skill situation id), \`kind\` (${ITEM_KINDS.join(", ")}), \`context\` (1 to ${TWIN.maxWords.context} words: what the passage is about or answers, no personal details).
- At least ${TWIN.minItemWords} words per item. No two items with the same text.
- At least ${TWIN.minSources} different sources. ${TWIN.minItemsPerSituation} to ${TWIN.maxItemsPerSituation} items per situation. At least ${TWIN.minDecisions} \`decision\` items.

## patterns.md
- Every section: ${TWIN_PATTERN_SECTIONS.join(", ")}. At most ${TWIN.maxWords.patterns} words, refs not counted.
- Every bullet outside "## Gaps" cites the trainer's material: \`[[<file id>#<turn>]]\` for a recording, \`[[<file id>]]\` for a doc, and only files your items use.

## SKILL.md (\`body\`)
- Every section: ${TWIN_SKILL_SECTIONS.join(", ")}. At most ${TWIN.maxWords.skill} words, no refs. Code adds the name/description header.
- Written as the trainer, in the first person ("I…", "my…"), at least ${TWIN.minFirstPerson} times; never "the trainer".
- "## Topic" names every situation. "## How I decide" has at least ${TWIN.minDecisionRules} rules, each with its condition ("when …, I … because …").
- No role-play structure: no roles, steps, moves or learner part.

## Everywhere
No names of people or companies, emails, phone numbers or links in anything you write; use roles or [name]. Pass the names you saw in \`names\`.
`;
}
