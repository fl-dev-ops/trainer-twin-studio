import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { pool, pullSources } from "./origin";
import { type Io, outPath, readJson, srcPath, userId } from "./paths";
import { lineTurns, parseDoc, render, speakerStats } from "./turns";

// shortcut: fixed bars, not learned per trainer; revisit after two trainers pass.
const MIN_SESSIONS = 3; // a scenario needs this many sessions
const MIN_MODE_ITEMS = 30; // a mode needs this many real session lines for its side
export const MAX_ITEMS = 15; // per side and action, so one long session cannot dominate
const MIN_PRACTICE = { turns: 20, perSide: 5 }; // a session counts only with this much two-sided practice inside its spans
const MAX_WORDS = { patterns: 2000, skill: 2000, context: 25 }; // hard limits; instructions aim lower so trimming is rare
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const STEPS = { min: 3, max: 6 };
// Move and item bars; tune per trainer later.
export const MAX_MOVES = 5; // per side per step
export const MIN_MOVE_ITEMS = 3; // supporting items a move needs, unless scenario.json flags it low_evidence
export const MIN_ITEM_WORDS = 6; // shorter lines are filler
const MAX_MOVE_DEF_WORDS = 30; // a move needing a longer definition is several moves
const MIN_RULE_SESSIONS = 2; // an always/never rule needs a pattern seen in at least this many sessions
const POSTS = /^data\/(linkedin|medium|twitter|instagram)\//;
const DOCS = /^data\/(docs|website)\//;
const PII = /[\w.+-]+@[\w-]+\.[\w.-]+|\bhttps?:\/\/\S+|\bwww\.\S+|\+?\d(?:[ .-]?\d){9,}/i;
// Evidence refs in patterns.md: [[<file id>#<turn>]] for a session turn, [[<file id>]] for a doc or post.
const REF = /\[\[([^\]#]+?)(?:#(\d+))?\]\]/g;
const COUNT = /\((\d+) of (\d+) sessions?\)/g;
// Any count, including the bare "(3 of 3)" that COUNT misses; only the full form may be written.
const ANY_COUNT = /\((\d+) of (\d+)(?: sessions?)?\)/g;
const CANONICAL = ["SKILL.md", "scenario.json", "items.json", "patterns.md"];
export const PATTERN_SECTIONS = ["## Session flow", "## Opening", "## Questions", "## Follow-ups", "## Reactions to answers", "## Moving on", "## Closing", "## Learner side", "## Style", "## From the method docs", "## Gaps"];
export const SKILL_SECTIONS = ["## Goal", "## Roles", "## How a session runs", "## Steps", "## Rules", "## Style", "## Playing the learner side"];

export type InventoryFile = { id: string; path: string; kind: "post" | "doc" | "media"; title?: string; turns?: number; speakers?: Record<string, { turns: number; words: number }>; candidate?: boolean };

const fileId = (rel: string) => rel.match(/\[([^\]]+)\]\.md$/)?.[1] ?? path.basename(rel, ".md");

/** Every markdown file, with speaker counts. Recordings with two or more real speakers are session candidates. */
export function buildInventory(files: { path: string; text: string }[]): InventoryFile[] {
  return files.map(({ path: rel, text }): InventoryFile => {
    if (POSTS.test(rel)) return { id: fileId(rel), path: rel, kind: "post" };
    if (DOCS.test(rel)) return { id: fileId(rel), path: rel, kind: "doc" };
    const { meta, turns } = parseDoc(text);
    const speakers = speakerStats(turns);
    const ranked = Object.values(speakers).sort((a, b) => b.words - a.words);
    const total = ranked.reduce((s, x) => s + x.words, 0) || 1;
    // Two people, the second with real share: >=20 turns, >=10% of words, >=8 turns.
    const candidate = turns.length >= 20 && ranked.length >= 2 && ranked[1].words / total >= 0.1 && ranked[1].turns >= 8;
    return { id: fileId(rel), path: rel, kind: "media", title: meta.title, turns: turns.length, speakers, candidate };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

/** Copies the user's sources into the sandbox once per session and returns the inventory. Later calls are one read. */
export async function ensureSynced(io: Io, user: string): Promise<InventoryFile[]> {
  const marker = srcPath(user, ".inventory.json");
  const cached = await io.read(marker);
  if (cached) return JSON.parse(cached);
  const files = await pullSources(user);
  if (!files.length) throw new Error(`no sources found for ${userId(user)}`);
  await pool(files, 16, (f) => io.write(srcPath(user, f.path), f.text));
  const inv = buildInventory(files);
  await io.write(marker, JSON.stringify(inv));
  return inv;
}

const loose = (s: string) => s.replace(/[|?"\\:*<>]/g, " ").replace(/\s+/g, " ").trim().normalize("NFC");

/** Models retype long file names badly. Accept the exact path, the id, or a path with the [id] or loose spacing. */
export function resolveSource(inv: InventoryFile[], ref: string) {
  const r = ref.trim().replace(/^users\/[^/]+\//, "");
  const paths = inv.map((f) => f.path);
  if (paths.includes(r)) return r;
  if (paths.includes(`data/${r}`)) return `data/${r}`;
  // The id is the last [..] before .md; titles can hold other brackets, like "[2022 technique]".
  const id = r.match(/\[([^\]]+)\](?:\.md)?\s*$/)?.[1] ?? (/^[^/\s]{6,}$/.test(r) ? r.replace(/\.md$/, "") : null);
  const hits = id ? inv.filter((f) => f.id === id).map((f) => f.path) : paths.filter((f) => loose(f) === loose(r) || loose(f) === loose(`data/${r}`));
  const uniq = [...new Set(hits)];
  if (uniq.length === 1) return uniq[0];
  throw new Error(uniq.length ? `ambiguous file: ${ref}` : `no such file: ${ref}. Use the path or id from the files tool.`);
}

/** The source text of one file, by path or id. */
export async function readSourceText(io: Io, user: string, inv: InventoryFile[], ref: string) {
  const rel = resolveSource(inv, ref);
  const text = await io.read(srcPath(user, rel));
  if (text == null) throw new Error(`no such file in the sandbox: ${rel}`);
  return { path: rel, text };
}

export const searchInput = z.object({
  patterns: z.array(z.string()).min(1).describe("Regexes, case-insensitive, any language. Put every phrasing in one call."),
  in: z.enum(["candidates", "recordings", "docs", "all"]).default("all").describe("candidates: two-person recordings. recordings: all recordings. docs: docs and posts."),
  files: z.array(z.string()).optional().describe("Only these file ids."),
  per_file: z.number().int().min(1).max(10).default(3),
  max_files: z.number().int().min(1).max(100).default(40),
});

/** One search over every file: per file the hit count and the first hits, with turn numbers for recordings. */
export async function search(io: Io, user: string, q: z.infer<typeof searchInput>) {
  const inv = await ensureSynced(io, user);
  const root = srcPath(user, "data").replace(/\/data$/, "");
  const want = new Set(q.files?.map((f) => resolveSource(inv, f)));
  const keep = (f: InventoryFile) => (!q.files || want.has(f.path)) &&
    (q.in === "all" || (q.in === "candidates" ? !!f.candidate : q.in === "recordings" ? f.kind === "media" : f.kind !== "media"));
  const byPath = new Map(inv.map((f) => [f.path, f]));
  const hits = new Map<InventoryFile, { line: number; text: string }[]>();
  for (const h of await io.grep(q.patterns, srcPath(user, "data"))) {
    const f = byPath.get(h.path.slice(root.length + 1));
    if (f && keep(f)) hits.set(f, [...(hits.get(f) ?? []), h]);
  }
  const ranked = [...hits].sort((a, b) => b[1].length - a[1].length);
  const files = await Promise.all(ranked.slice(0, q.max_files).map(async ([f, hs]) => {
    const at = f.kind === "media" ? lineTurns((await io.read(srcPath(user, f.path))) ?? "") : null;
    const seen = new Set<number>();
    const snippets = hs.flatMap((h) => {
      const where = at ? at[h.line] : h.line;
      if (seen.has(where) || seen.size >= q.per_file) return [];
      seen.add(where);
      return [`${at ? `#${where}` : `L${h.line}`} ${h.text.trim().slice(0, 200)}`];
    });
    return { id: f.id, kind: f.kind === "media" ? (f.candidate ? "candidate" : "recording") : f.kind, ...(f.turns ? { turns: f.turns } : {}), hits: hs.length, snippets };
  }));
  return { files_matched: hits.size, shown: files.length, files };
}

// Names live only in work/names.json (never published), keyed by file id or scenario. Redaction uses every name known.
const NAMES = "work/names.json";

export async function knownNames(io: Io, user: string) {
  return [...new Set(Object.values(await readJson<Record<string, string[]>>(io, user, NAMES, {})).flat())];
}

async function addNames(io: Io, user: string, key: string, names: string[]) {
  const all = await readJson<Record<string, string[]>>(io, user, NAMES, {});
  all[key] = [...new Set([...(all[key] ?? []), ...names.map((n) => n.trim()).filter((n) => n.length >= 2)])];
  await io.write(outPath(user, NAMES), JSON.stringify(all, null, 1) + "\n");
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Case-sensitive, whole word: "Will" the person is hidden, "will" the verb stays.
const nameRes = (names: string[]) => names.map((n) => n.trim()).filter((n) => n.length >= 2).sort((a, b) => b.length - a.length).map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, "gu"));

export function redactor(names: string[]) {
  const res = nameRes(names);
  return (s: string) => res.reduce((acc, re) => acc.replace(re, "[name]"), s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    .replace(/\+?\d(?:[ .-]?\d){9,}/g, "[phone]"); // 10+ digits; shorter runs (years, counts, code) stay
}

/** Personal details found in a text: known names, emails, links, phone numbers. */
export function leaks(text: string, names: string[]) {
  const found = nameRes(names).flatMap((re) => text.match(re) ?? []);
  const pii = text.match(new RegExp(PII.source, "gi")) ?? [];
  return [...new Set([...found, ...pii])];
}

async function leakReasons(io: Io, user: string, file: string, text: string) {
  const found = leaks(text, await knownNames(io, user));
  return found.length ? [`${file} holds personal details: ${found.slice(0, 8).join(", ")}. Use roles such as "the trainer" or "the learner", or [name]`] : [];
}

/** Every count must read "(k of N sessions)" with N the real session count and k <= N. */
function countReasons(text: string, sessions: number, file: string) {
  const reasons: string[] = [];
  for (const m of text.matchAll(ANY_COUNT)) {
    const [k, n] = [Number(m[1]), Number(m[2])];
    if (!/sessions?\)$/.test(m[0])) reasons.push(`${file}: "${m[0]}" must read "(${k} of ${n} sessions)"`);
    if (n !== sessions) reasons.push(`${file}: "${m[0]}": this scenario has ${sessions} sessions`);
    else if (k < 1 || k > n) reasons.push(`${file}: "${m[0]}": k must be between 1 and ${n}`);
  }
  return reasons;
}

// Frequency words must agree with the count in the same sentence, so "in one session ... (3 of 3)" cannot pass.
const FREQ: [RegExp, (k: number, n: number) => boolean, string][] = [
  [/\b(?:in )?(?:one|a single) session\b|\bin session \d\b|\bonly once\b/i, (k) => k === 1, "one session needs (1 of N sessions)"],
  [/\b(?:every|all|each) sessions?\b/i, (k, n) => k === n, "every session needs (N of N sessions)"],
  [/\bmost sessions\b/i, (k, n) => k > n / 2, "most sessions needs k above half of N"],
];
function frequencyReasons(text: string, file: string) {
  const reasons: string[] = [];
  for (const sentence of text.split(/(?<=[.;!?])\s+|\n/)) {
    const counts = [...sentence.matchAll(ANY_COUNT)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [re, ok, why] of FREQ) {
      const hit = sentence.match(re);
      if (!hit) continue;
      if (!counts.length) reasons.push(`${file}: "${sentence.trim().slice(0, 120)}" says "${hit[0]}" without a (k of N sessions) count`);
      else if (!counts.some(([k, n]) => ok(k, n))) reasons.push(`${file}: "${sentence.trim().slice(0, 120)}": ${why}`);
    }
  }
  return reasons;
}

/** Lines under one "## " section, up to the next "## ". */
function section(text: string, heading: string) {
  const i = text.indexOf(heading);
  if (i < 0) return "";
  const rest = text.slice(i + heading.length);
  const j = rest.search(/\n## /);
  return j < 0 ? rest : rest.slice(0, j);
}

// ---------- plan.json ----------

const kebab = z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case, at most 64 characters");
export const planInput = z.object({
  scenarios: z.array(z.object({
    id: kebab,
    name: z.string(),
    goal: z.string().describe("One line, people by role, never by name."),
    spec: z.string().optional().describe("The spec file this scenario serves, if any."),
    sessions: z.array(z.object({
      id: z.string().describe("File id of a two-person recording."),
      trainer: z.array(z.string()).min(1).describe("Speaker labels of the trainer side; diarization can split one person, list all."),
      learner: z.array(z.string()).min(1).describe("Speaker labels of the learner side."),
      plays: z.record(z.string(), z.string().max(160)).optional().describe("For every speaker label above: the part that person plays in the practice, by role, e.g. \"coach; plays the client in role-plays\", \"agent\", \"observer\". Say when it changes, e.g. \"coach; demonstrates the agent in turns 40-60\"."),
      spans: z.array(z.tuple([z.number().int(), z.number().int()])).min(1).describe("Inclusive turn ranges that hold the practice, and only the practice."),
    })),
    method: z.array(z.string()).default([]).describe("File ids of docs, posts or solo recordings that explain this practice."),
  })),
});
export type PlanInput = z.infer<typeof planInput>;
/** A planned file with what later stages need. `use` tells sessions from method files. */
export type PlanFile = { id: string; path: string; use: "session" | "method"; trainer: string[]; learner: string[]; spans: [number, number][]; turns?: number; plays?: Record<string, string> };

/** Turns inside a session's spans spoken by each side. */
export async function practiceTurns(io: Io, user: string, r: PlanFile) {
  const text = (await io.read(srcPath(user, r.path))) ?? "";
  const inSpan = parseDoc(text).turns.filter((t) => r.spans.some(([a, b]) => t.n >= a && t.n <= b));
  const trainer = inSpan.filter((t) => r.trainer.includes(t.speaker)).length;
  const learner = inSpan.filter((t) => r.learner.includes(t.speaker)).length;
  return { trainer, learner, solid: trainer + learner >= MIN_PRACTICE.turns && Math.min(trainer, learner) >= MIN_PRACTICE.perSide };
}

/** Checks a plan against the sources. Returns the problems, and the plan with ids resolved. */
async function validatePlan(io: Io, user: string, plan: PlanInput) {
  const inv = await ensureSynced(io, user);
  const reasons: string[] = [];
  const ids = new Set<string>();
  const resolve = (scenario: string, ref: string) => { try { return inv.find((f) => f.path === resolveSource(inv, ref))!; } catch (e) { reasons.push(`${scenario}: ${(e as Error).message}`); return null; } };
  const scenarios = [];
  for (const s of plan.scenarios) {
    if (ids.has(s.id)) reasons.push(`${s.id}: listed twice`);
    ids.add(s.id);
    if (s.spec && (await io.read(outPath(user, s.spec))) == null) reasons.push(`${s.id}: spec ${s.spec} is missing`);
    const sessions = [];
    let solid = 0;
    for (const x of s.sessions) {
      const f = resolve(s.id, x.id);
      if (!f) continue;
      const bad = (why: string) => reasons.push(`${s.id}: ${f.id}: ${why}`);
      const labels = Object.keys(f.speakers ?? {});
      const unknown = [...x.trainer, ...x.learner].filter((l) => !labels.includes(l));
      if (f.kind !== "media") { bad(`a ${f.kind} cannot be a session`); continue; }
      if (unknown.length) { bad(`no speaker ${unknown.join(", ")}; labels are ${labels.join(", ")}`); continue; }
      if (x.trainer.some((l) => x.learner.includes(l))) { bad("a speaker is on both sides"); continue; }
      const labelled = [...x.trainer, ...x.learner];
      if (!x.plays || labelled.some((l) => !x.plays![l]?.trim())) { bad(`plays must say, for each of ${labelled.join(", ")}, the part that person plays (coach, client, agent, observer...)`); continue; }
      if (Object.keys(x.plays).some((l) => !labelled.includes(l))) { bad(`plays names a speaker that is not on either side`); continue; }
      if (x.spans.some(([a, b]) => a < 0 || b < a || b >= (f.turns ?? 0))) { bad(`spans must be inclusive turn ranges within 0-${(f.turns ?? 1) - 1}`); continue; }
      const r: PlanFile = { id: f.id, path: f.path, use: "session", trainer: x.trainer, learner: x.learner, spans: x.spans, turns: f.turns };
      const p = await practiceTurns(io, user, r);
      if (p.solid) solid++;
      else bad(`only ${p.trainer + p.learner} practice turns in its spans (trainer ${p.trainer}, learner ${p.learner}); a session needs ${MIN_PRACTICE.turns}, at least ${MIN_PRACTICE.perSide} per side. Widen the spans only if the practice really runs longer; otherwise drop it`);
      sessions.push({ ...x, id: f.id });
    }
    if (new Set(sessions.map((x) => x.id)).size !== sessions.length) reasons.push(`${s.id}: a session is listed twice`);
    if (solid < MIN_SESSIONS) reasons.push(`${s.id}: ${solid} sessions with real practice; a scenario needs ${MIN_SESSIONS}. If the data has no more, do not plan it; report it in not_planned`);
    const method = s.method.map((m) => resolve(s.id, m)?.id).filter((m): m is string => !!m);
    scenarios.push({ ...s, sessions, method });
  }
  // Only text the agent writes; file ids hold dates that look like phone numbers.
  reasons.push(...(await leakReasons(io, user, "plan.json", plan.scenarios.map((s) => `${s.name} ${s.goal} ${s.sessions.map((x) => Object.values(x.plays ?? {}).join(" ")).join(" ")}`).join("\n"))));
  return { reasons, plan: { scenarios } };
}

/** Saves plan.json only when it is valid. Names go to work/names.json, never into the plan. */
export async function savePlan(io: Io, user: string, input: PlanInput, names: string[]) {
  if (names.length) await addNames(io, user, "plan", names);
  const v = await validatePlan(io, user, input);
  if (v.reasons.length) return { saved: false, errors: v.reasons };
  await io.write(outPath(user, "plan.json"), JSON.stringify(v.plan, null, 1) + "\n");
  return { saved: true, scenarios: v.plan.scenarios.map((s) => ({ id: s.id, sessions: s.sessions.length, method: s.method.length })) };
}

/** Stage 1: plan.json exists and is valid. An empty plan is valid. */
export async function checkScout(io: Io, user: string) {
  const raw = await readJson<unknown>(io, user, "plan.json", null);
  if (raw == null) return { pass: false, reasons: ["plan.json is missing"] };
  const plan = planInput.safeParse(raw);
  if (!plan.success) return { pass: false, reasons: [`plan.json: ${plan.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`] };
  const { reasons } = await validatePlan(io, user, plan.data);
  return { pass: !reasons.length, reasons, scenarios: plan.data.scenarios.map((s) => ({ id: s.id, sessions: s.sessions.length, method: s.method.length })) };
}

/** A planned scenario with its files, ready for later stages. Throws when the plan or scenario is missing. */
export async function scenarioFiles(io: Io, user: string, scenario: string) {
  const inv = await ensureSynced(io, user);
  const plan = planInput.parse(await readJson(io, user, "plan.json", null));
  const s = plan.scenarios.find((x) => x.id === scenario);
  if (!s) throw new Error(`"${scenario}" is not in output/${userId(user)}/plan.json`);
  const file = (ref: string) => inv.find((f) => f.path === resolveSource(inv, ref))!;
  const sessions: PlanFile[] = s.sessions.map((x) => { const f = file(x.id); return { id: f.id, path: f.path, use: "session", trainer: x.trainer, learner: x.learner, spans: x.spans, turns: f.turns, plays: x.plays }; });
  const method: PlanFile[] = s.method.map((m) => { const f = file(m); return { id: f.id, path: f.path, use: "method", trainer: [], learner: [], spans: [] }; });
  return { inv, s, sessions, method };
}

// ---------- reading a planned scenario, in code-sized batches ----------

// Bytes, not English-only token estimates. Large files continue on the next page; nothing is discarded.
export const BATCH_BYTES = 24_000;
export const batchCursor = z.object({ file: z.number().int().nonnegative(), offset: z.number().int().nonnegative() });

/** Reads only the files reached by this page. Offsets address UTF-8 bytes in the rendered file. */
export async function readBatch(io: Io, user: string, scenario: string, kind: "sessions" | "method", cursor = { file: 0, offset: 0 }) {
  const { inv, sessions, method } = await scenarioFiles(io, user, scenario);
  const files = kind === "sessions" ? sessions : method;
  let { file, offset } = batchCursor.parse(cursor);
  if (file > files.length || (file === files.length && offset)) throw new Error("invalid batch cursor");
  let remaining = BATCH_BYTES;
  const parts: { id: string; offset: number; header: string; text: string }[] = [];
  while (file < files.length && remaining > 1024) {
    const r = files[file];
    const raw = (await readSourceText(io, user, inv, r.path)).text;
    const turns = kind === "sessions" ? parseDoc(raw).turns : [];
    const text = kind === "sessions" ? render(turns.filter((t) => r.spans.some(([a, b]) => t.n >= a && t.n <= b))) : raw;
    const bytes = Buffer.from(text);
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) throw new Error("invalid batch offset");
    // Repeat a split turn's label so a long answer never loses its source turn number.
    const prefix = bytes.subarray(0, offset).toString();
    const label = kind === "sessions" && offset && !prefix.endsWith("\n") ? prefix.slice(prefix.lastIndexOf("\n") + 1).match(/^\[\d+\] [^:]+:/)?.[0] : null;
    const header = `${r.id}${kind === "sessions" ? ` | trainer: ${r.trainer.join(", ")} | learner: ${r.learner.join(", ")}${r.plays ? ` | plays: ${Object.entries(r.plays).map(([l, v]) => `${l}=${v}`).join("; ")}` : ""} | spans ${JSON.stringify(r.spans)}` : ""}${offset ? ` | continuation at byte ${offset}${label ? ` of ${label}` : ""}` : ""}`;
    const overhead = Buffer.byteLength(JSON.stringify({ id: r.id, offset, header, text: "" })) + 64;
    if (overhead + 8 >= remaining) {
      if (!parts.length) throw new Error("source header exceeds the batch size");
      break;
    }
    let end = Math.min(bytes.length, offset + remaining - overhead);
    let part: { id: string; offset: number; header: string; text: string };
    for (;;) {
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const newline = bytes.lastIndexOf(10, end - 1);
      if (end < bytes.length && newline > offset + (end - offset) / 2) end = newline + 1;
      part = { id: r.id, offset, header, text: bytes.subarray(offset, end).toString() };
      if (Buffer.byteLength(JSON.stringify(part)) + 64 <= remaining) break;
      end = offset + Math.floor((end - offset) / 2);
    }
    parts.push(part);
    remaining -= Buffer.byteLength(JSON.stringify(part)) + 64;
    if (end < bytes.length) { offset = end; break; }
    file++; offset = 0;
  }
  return { parts, next: file < files.length ? { file, offset } : null };
}

// ---------- 2. pattern ----------

/** Stage 2: patterns.md has every section, cites every session, and every "(k of N sessions)" cites k sessions on its line. */
export async function checkPattern(io: Io, user: string, scenario: string) {
  const { inv, sessions, method } = await scenarioFiles(io, user, scenario);
  const text = await io.read(outPath(user, `${scenario}/patterns.md`));
  if (text == null) return { pass: false, reasons: ["patterns.md is missing"] };
  const reasons = PATTERN_SECTIONS.filter((h) => !text.includes(h)).map((h) => `missing section "${h}"`);
  const n = words(text.replace(REF, ""));
  if (n > MAX_WORDS.patterns) reasons.push(`patterns.md has ${n} words without refs, ${n - MAX_WORDS.patterns} over ${MAX_WORDS.patterns}. Trim with edit: merge repeated bullets, shorten examples`);
  const mine = new Map([...sessions, ...method].map((r) => [r.path, r]));
  const cited = new Set<string>();
  const refsOf = (line: string) => [...line.matchAll(REF)].map((m) => {
    let rel: string;
    try { rel = resolveSource(inv, m[1]); } catch { reasons.push(`ref [[${m[0].slice(2, -2)}]] is not a file`); return null; }
    const r = mine.get(rel);
    if (!r) { reasons.push(`ref ${m[0]} is not one of this scenario's files`); return null; }
    if (r.use === "session" && (m[2] == null || Number(m[2]) >= (r.turns ?? 0))) reasons.push(`ref ${m[0]} needs a turn number within 0-${(r.turns ?? 1) - 1}`);
    return r;
  }).filter((r): r is PlanFile => !!r);
  const OBSERVED = PATTERN_SECTIONS.filter((h) => h !== "## From the method docs" && h !== "## Gaps");
  let heading = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) heading = line.trim();
    const refs = refsOf(line);
    // Every observation says how often it was seen, so later stages can tell a habit from a one-off.
    if (OBSERVED.includes(heading) && /^\s*[-*] /.test(line) && refs.some((r) => r.use === "session") && !line.match(COUNT))
      reasons.push(`bullet under "${heading}" cites sessions but has no (k of ${sessions.length} sessions) count: "${line.trim().slice(0, 100)}"`);
    for (const r of refs) if (r.use === "session") cited.add(r.path);
    for (const m of line.matchAll(COUNT)) {
      const [k, n] = [Number(m[1]), Number(m[2])];
      const distinct = new Set(refs.filter((r) => r.use === "session").map((r) => r.path)).size;
      if (n !== sessions.length) reasons.push(`"${m[0]}": this scenario has ${sessions.length} sessions`);
      else if (distinct < k) reasons.push(`"${m[0]}" cites ${distinct} sessions on its line; cite one turn from each of the ${k}`);
    }
  }
  const uncited = sessions.filter((r) => !cited.has(r.path));
  if (uncited.length) reasons.push(`sessions never cited: ${uncited.map((r) => r.id).join(", ")}`);
  const prose = text.replace(REF, "");
  reasons.push(...countReasons(prose, sessions.length, "patterns.md"), ...frequencyReasons(prose, "patterns.md"));
  reasons.push(...(await leakReasons(io, user, "patterns.md", text.replace(REF, ""))));
  return { pass: !reasons.length, reasons: [...new Set(reasons)] };
}

// ---------- 3. skill ----------

export const skillHead = z.object({
  scenario: kebab,
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).max(1024).regex(/^[^<>]+$/, "description cannot contain angle brackets"),
  trainer_role: z.string(),
  learner_role: z.string(),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case"),
    name: z.string(),
    parts: z.object({ trainer: z.string().min(1), learner: z.string().min(1) }).describe("The recorded part each side plays during this step."),
    trainer_moves: z.array(z.string()).min(1).max(MAX_MOVES),
    learner_moves: z.array(z.string()).min(1).max(MAX_MOVES),
    low_evidence: z.array(z.string()).optional().describe(`Moves of this step kept with fewer than ${MIN_MOVE_ITEMS} real lines. SKILL.md marks each "(low evidence)".`),
  })).min(STEPS.min).max(STEPS.max),
});
export type SkillHead = z.infer<typeof skillHead>;

/** Manifest rules zod cannot express: unique moves per side, and flags that name real moves of their step. */
function headReasons(head: SkillHead) {
  const reasons: string[] = [];
  for (const st of head.steps) {
    const all = [...st.trainer_moves, ...st.learner_moves];
    for (const [side, moves] of [["trainer", st.trainer_moves], ["learner", st.learner_moves]] as const)
      if (new Set(moves).size !== moves.length) reasons.push(`${st.id}: a ${side} move is listed twice`);
    for (const key of ["low_evidence"] as const)
      for (const m of st[key] ?? []) if (!all.includes(m)) reasons.push(`${st.id}: ${key} names "${m}", not a move of this step`);
  }
  return reasons;
}

// JSON-quoted strings are valid YAML scalars; no YAML parser is needed for the header we generate.
export const skillHeader = (head: SkillHead) => `---\nname: ${head.scenario}\ndescription: ${JSON.stringify(head.description)}\n---\n`;

/** The skill stage owns both the readable skill and its machine-readable scenario metadata. */
export async function saveSkill(io: Io, user: string, input: SkillHead, body: string) {
  const head = skillHead.parse(input);
  if (!body.trim() || body.trimStart().startsWith("---")) throw new Error("Pass the Markdown body without front matter; code creates the YAML header.");
  const text = skillHeader(head) + body.trim() + "\n";
  const reasons = [...headReasons(head), ...(await leakReasons(io, user, "SKILL.md and scenario.json", `${text}\n${JSON.stringify(head)}`))];
  if (reasons.length) return { saved: false, reasons };
  await io.write(outPath(user, `${head.scenario}/scenario.json`), JSON.stringify(head, null, 2) + "\n");
  await io.write(outPath(user, `${head.scenario}/SKILL.md`), text);
  return { saved: true, reasons: [], words: words(body) };
}

/** Reads the manifest separately; the skill header stays limited to name and description. */
export async function readSkill(io: Io, user: string, scenario: string) {
  const text = await io.read(outPath(user, `${scenario}/SKILL.md`));
  if (text == null) return { text: null, head: null, error: "SKILL.md is missing; use save_skill to create it and scenario.json" };
  let raw: unknown;
  try { raw = await readJson(io, user, `${scenario}/scenario.json`, null); }
  catch { return { text, head: null, error: "scenario.json is not valid JSON" }; }
  if (raw == null) return { text, head: null, error: "scenario.json is missing; save_skill writes it together with SKILL.md" };
  const head = skillHead.safeParse(raw);
  if (!head.success) return { text, head: null, error: `scenario.json: ${head.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  if (!text.startsWith(skillHeader(head.data))) return { text, head: null, error: "SKILL.md needs the YAML name/description header generated by save_skill, matching scenario.json" };
  return { text, head: head.data, error: null };
}

/** Stage 3: valid front matter, every section and step present, and every session count copied from patterns.md. */
export async function checkSkill(io: Io, user: string, scenario: string) {
  // Exact names only: a lowercase skill.md (old runs, or a case-insensitive disk) is not the published file.
  const dir = outPath(user, scenario);
  const present = (await io.list(dir)).map((p) => p.slice(dir.length + 1)).filter((p) => !p.includes("/"));
  const odd = present.filter((p) => !CANONICAL.includes(p) && CANONICAL.some((c) => c.toLowerCase() === p.toLowerCase()));
  if (odd.length) return { pass: false, reasons: [`${odd.join(", ")}: wrong file name; only ${CANONICAL.join(", ")} are read. Save again with save_skill`] };
  const sk = await readSkill(io, user, scenario);
  if (!sk.head) return { pass: false, reasons: [sk.error!] };
  const body = sk.text!;
  const { sessions } = await scenarioFiles(io, user, scenario);
  const reasons = SKILL_SECTIONS.filter((h) => !body.includes(h)).map((h) => `missing section "${h}"`);
  const after = body.slice(skillHeader(sk.head).length);
  const n = words(after);
  // Refs serve reviewers, not the runtime: the evidence stays in patterns.md.
  const refs = [...after.matchAll(REF)].length;
  if (refs) reasons.push(`SKILL.md holds ${refs} refs like [[id#turn]]; remove them, the evidence stays in patterns.md`);
  if (n > MAX_WORDS.skill) reasons.push(`SKILL.md has ${n} words after the front matter, ${n - MAX_WORDS.skill} over ${MAX_WORDS.skill}. Trim with edit; it decides what happens next and does not restate patterns.md`);
  if (sk.head.scenario !== scenario) reasons.push(`scenario.json scenario is "${sk.head.scenario}", not "${scenario}"`);
  const ids = sk.head.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) reasons.push("step ids must be unique");
  const steps = body.slice(body.indexOf("## Steps"));
  for (const id of ids) if (!steps.includes(`\`${id}\``)) reasons.push(`step \`${id}\` has no section under "## Steps"`);
  reasons.push(...headReasons(sk.head));
  // Each move has one short definition line in its step's section: "- `move`: what it does".
  for (const st of sk.head.steps) {
    const at = steps.indexOf(`\`${st.id}\``);
    if (at < 0) continue;
    const next = steps.indexOf("\n### ", at);
    const part = steps.slice(at, next < 0 ? undefined : next).split("\n");
    for (const m of [...st.trainer_moves, ...st.learner_moves]) {
      const line = part.find((l) => l.includes(`\`${m}\`:`));
      if (!line) { reasons.push(`${st.id}: move \`${m}\` has no "\`${m}\`: definition" line in its step section`); continue; }
      const def = words(line.slice(line.indexOf(`\`${m}\`:`) + m.length + 3).replace(/\(low evidence\)/gi, ""));
      if (def > MAX_MOVE_DEF_WORDS) reasons.push(`${st.id}: \`${m}\` takes ${def} words to define; over ${MAX_MOVE_DEF_WORDS} means it lumps several moves. Split it or narrow it`);
      if (st.low_evidence?.includes(m) && !/low evidence/i.test(line)) reasons.push(`${st.id}: \`${m}\` is flagged low_evidence; mark its line "(low evidence)"`);
    }
  }
  const patterns = (await io.read(outPath(user, `${scenario}/patterns.md`))) ?? "";
  for (const m of body.matchAll(COUNT)) if (!patterns.includes(m[0])) reasons.push(`"${m[0]}" is not in patterns.md; copy counts from there, never compute them`);
  reasons.push(...countReasons(after, sessions.length, "SKILL.md"), ...frequencyReasons(after, "SKILL.md"));
  // Rules are scoped to evidence: each carries its count or "(method docs)", and absolute rules need repeated evidence.
  for (const line of section(after, "## Rules").split("\n").filter((l) => /^\s*[-*] /.test(l))) {
    const counts = [...line.matchAll(COUNT)].map((m) => Number(m[1]));
    const docs = /\(method docs\)/i.test(line);
    const short = line.trim().slice(0, 100);
    if (!counts.length && !docs) reasons.push(`rule "${short}" needs its evidence: a (k of ${sessions.length} sessions) count from patterns.md or "(method docs)"`);
    else if (!docs && /\b(always|never|every|must)\b/i.test(line) && Math.max(...counts) < MIN_RULE_SESSIONS)
      reasons.push(`rule "${short}" says always/never on one session; scope it ("when ...", "in this scenario") or drop it`);
  }
  reasons.push(...(await leakReasons(io, user, "SKILL.md and scenario.json", `${body}\n${JSON.stringify(sk.head)}`)));
  const items = await readJson<Item[]>(io, user, `${scenario}/items.json`, []);
  const linked = (role: string, move: string, part: string) => items.filter((x) => x.role === role && x.metadata.action === move && x.metadata.part === part);
  const unsupported: string[] = [];
  for (const st of sk.head.steps) for (const [role, moves] of [["trainer", st.trainer_moves], ["learner", st.learner_moves]] as const)
    for (const move of moves) {
      const rows = linked(role, move, st.parts[role]);
      if (!rows.length) unsupported.push(`${st.id}.${role}.${move}`);
      else if (rows.length < MIN_MOVE_ITEMS && !st.low_evidence?.includes(move)) reasons.push(`${st.id}.${role}.${move}: ${rows.length} supporting items; flag low_evidence or choose another repeated action`);
    }
  if (unsupported.length) reasons.push(`moves without matching evidence: ${unsupported.join(", ")}`);
  return { pass: !reasons.length, reasons: [...new Set(reasons)], steps: ids, unsupported_moves: unsupported };
}

// ---------- 4. items ----------

export const itemInput = z.object({
  source: z.string().describe("File id of a planned session or method file."),
  n: z.number().int().optional().describe("Session turn number. Sessions only."),
  quote: z.string().optional().describe("Exact text copied from a method file. Method files only."),
  start: z.string().optional().describe("Optional exact first words of the relevant part of a session turn."),
  end: z.string().optional().describe("Optional exact last words of that part. Omit both to keep the whole turn."),
  role: z.enum(["trainer", "learner"]),
  part: z.string().trim().min(1).max(80).describe("The part this speaker is playing in this line, such as coach, client, agent or observer."),
  action: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "kebab-case").describe("The one concrete action this line performs."),
  context: z.string().describe("The situation this line responds to, quoting the previous turn's key phrase. No personal details."),
});
export type Item = { id: string; role: "trainer" | "learner"; context: string; text: string; metadata: { scenario_id: string; action: string; part: string; source: string; kind: "session" | "doc"; ref: number | null; words: number } };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Builds evidence before a playbook exists. Code copies exact text and checks source, side and part played. */
export async function makeItems(io: Io, user: string, scenario: string, picks: z.infer<typeof itemInput>[]) {
  const { inv, sessions, method } = await scenarioFiles(io, user, scenario);
  const redact = redactor(await knownNames(io, user));
  const mine = new Map([...sessions, ...method].map((r) => [r.path, r]));
  const texts = new Map<string, string>();
  const items: Item[] = [];
  const errors: string[] = [];
  for (const [i, p] of picks.entries()) {
    const bad = (why: string) => errors.push(`#${i} ${p.action} (${p.source}${p.n != null ? `#${p.n}` : ""}): ${why}`);
    let rel: string;
    try { rel = resolveSource(inv, p.source); } catch (e) { bad((e as Error).message); continue; }
    const r = mine.get(rel);
    if (!r) { bad("not one of this scenario's files"); continue; }
    if (!texts.has(rel)) texts.set(rel, (await readSourceText(io, user, inv, rel)).text);
    const context = redact(p.context.trim());
    if (!context) { bad("context is empty"); continue; }
    if (words(context) > MAX_WORDS.context) { bad(`context has ${words(context)} words; keep it under ${MAX_WORDS.context}`); continue; }
    let text: string;
    let span: number | null = null; // character offset of a sub-span within the redacted turn
    if (r.use === "session") {
      const t = p.n == null ? undefined : parseDoc(texts.get(rel)!).turns[p.n];
      if (!t) { bad("needs a turn number n from the transcript"); continue; }
      if (!r.spans.some(([a, b]) => p.n! >= a && p.n! <= b)) { bad(`turn ${p.n} is outside the scouted spans ${JSON.stringify(r.spans)}`); continue; }
      const side = r.trainer.includes(t.speaker) ? "trainer" : r.learner.includes(t.speaker) ? "learner" : null;
      if (side !== p.role) { bad(`turn ${p.n} is spoken by ${t.speaker}, the ${side ?? "other"} side`); continue; }
      const allowedParts = Object.entries(r.plays ?? {}).filter(([label]) => (p.role === "trainer" ? r.trainer : r.learner).includes(label)).map(([, part]) => part);
      if (r.plays && !allowedParts.includes(p.part)) { bad(`part "${p.part}" is not recorded for this side; use ${allowedParts.join(" | ")}`); continue; }
      const whole = squash(t.text);
      if (p.quote) { bad("session lines use n, not quote"); continue; }
      if (p.start || p.end) {
        const a = p.start ? whole.indexOf(squash(p.start)) : 0;
        if (a < 0) { bad("start is not in this turn; copy its first words exactly"); continue; }
        const e = p.end ? whole.indexOf(squash(p.end), a) : -1;
        if (p.end && e < 0) { bad("end is not in this turn after start; copy its last words exactly"); continue; }
        const rawEnd = p.end ? e + squash(p.end).length : whole.length;
        text = redact(whole.slice(a, rawEnd).trim());
        span = text === redact(whole) ? null : a;
      } else { text = redact(t.text); span = null; }
    } else {
      if (p.role !== "trainer") { bad("lines from docs and posts are the trainer's; role must be trainer"); continue; }
      // Stored quotes are redacted, so a re-check matches against the redacted file too.
      const doc = texts.get(rel)!;
      if (!p.quote || !(squash(doc).includes(squash(p.quote)) || squash(redact(doc)).includes(squash(p.quote)))) { bad("quote must be copied exactly from the file"); continue; }
      text = redact(squash(p.quote));
    }
    const ref = r.use === "session" ? p.n! : null;
    const n = words(text);
    if (n < MIN_ITEM_WORDS) { bad(`"${text}" has ${n} words; skip fillers under ${MIN_ITEM_WORDS} words`); continue; }
    const key = ref != null ? (span != null ? `${ref}@${span}` : `${ref}`) : `q${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
    items.push({ id: `${scenario}/${r.id}#${key}`, role: p.role, context, text,
      metadata: { scenario_id: scenario, action: p.action, part: redact(p.part), source: r.id, kind: r.use === "session" ? "session" : "doc", ref, words: n } });
  }
  return { items, errors };
}

/** Upserts individual source lines, preserving other batches. Rejected edits never delete saved items. */
export async function saveItems(io: Io, user: string, scenario: string, picks: z.infer<typeof itemInput>[], names: string[] = [], remove: string[] = []) {
  if (names.length) await addNames(io, user, scenario, names);
  const { items, errors } = await makeItems(io, user, scenario, picks);
  const before = await readJson<Item[]>(io, user, `${scenario}/items.json`, []);
  for (const id of remove) if (!before.some((x) => x.id === id)) errors.push(`cannot remove unknown item ${id}`);
  const ids = items.map((x) => x.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`${id} is picked twice in this call; one line serves one move`);
  if (errors.length) return { saved: 0, rejected: errors };
  // A pick for a saved id corrects it; say so, so a line is never silently moved between moves.
  const moved = items.flatMap((it) => { const old = before.find((x) => x.id === it.id); return old && (old.metadata.action !== it.metadata.action || old.metadata.part !== it.metadata.part) ? [`${it.id}: ${old.metadata.part}/${old.metadata.action} -> ${it.metadata.part}/${it.metadata.action}`] : []; });
  const byId = new Map(before.filter((x) => !remove.includes(x.id)).map((x) => [x.id, x]));
  for (const it of items) byId.set(it.id, it);
  const out = [...byId.values()];
  for (const action of new Set(out.map((x) => `${x.role}:${x.metadata.action}`))) if (out.filter((x) => `${x.role}:${x.metadata.action}` === action).length > MAX_ITEMS)
    errors.push(`${action}: over the cap of ${MAX_ITEMS} items`);
  const fresh = new Set(items.map((x) => x.id));
  // Reasons name ids followed by a space, so "#1" never matches "#10".
  errors.push(...duplicateReasons(out).filter((r) => [...fresh].some((id) => r.includes(`${id} `))));
  if (errors.length) return { saved: 0, rejected: [...new Set(errors)] };
  const redact = redactor(await knownNames(io, user));
  await io.write(outPath(user, `${scenario}/items.json`), JSON.stringify(out.map((x) => ({ ...x, text: redact(x.text), context: redact(x.context) })), null, 1) + "\n");
  return { saved: items.length, removed: remove.length, rejected: [], ...(moved.length ? { moved } : {}) };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** One source span supports one action. Positions come from the original source, so redaction cannot move them. */
export function duplicateReasons(items: Item[]) {
  const reasons: string[] = [];
  const span = (id: string, text: string) => { const m = id.match(/@(\d+)$/); return m ? [Number(m[1]), Number(m[1]) + text.length] as const : null; };
  for (const [i, a] of items.entries()) for (const b of items.slice(i + 1)) {
    if (norm(a.text) === norm(b.text)) reasons.push(`${a.id} and ${b.id} have the same text ("${a.text.slice(0, 60)}"); keep one action`);
    const [x, y] = [span(a.id, a.text), span(b.id, b.text)];
    if (a.metadata.source === b.metadata.source && a.metadata.ref === b.metadata.ref && x && y && x[0] < y[1] && y[0] < x[1])
      reasons.push(`${a.id} and ${b.id} overlap in one turn; use non-overlapping start/end ranges or keep one`);
  }
  return reasons;
}

/** Evidence is valid before a playbook exists. It checks source fidelity, privacy, coverage and duplicates. */
export async function checkItems(io: Io, user: string, scenario: string) {
  const raw = await io.read(outPath(user, `${scenario}/items.json`));
  if (raw == null) return { pass: false, reasons: ["items.json is missing"] };
  const items = JSON.parse(raw) as Item[];
  const picks = items.map((x) => ({ source: x.metadata.source, n: x.metadata.ref ?? undefined, quote: x.metadata.kind === "doc" ? x.text : undefined, role: x.role, part: x.metadata.part, action: x.metadata.action, context: x.context }));
  const rebuilt = await makeItems(io, user, scenario, picks);
  const reasons = [...rebuilt.errors, ...duplicateReasons(items)];
  for (const it of items) if (!rebuilt.items.some((r) => r.id === it.id && r.text === it.text && r.metadata.part === it.metadata.part)) reasons.push(`${it.id}: does not rebuild from its source`);
  const names = await knownNames(io, user);
  for (const it of items) { const found = leaks(`${it.text} ${it.context} ${it.metadata.part}`, names); if (found.length) reasons.push(`${it.id}: holds personal details (${found.join(", ")})`); }
  const real = (role: string) => items.filter((x) => x.role === role && x.metadata.kind === "session").length;
  const modes = [...(real("trainer") >= MIN_MODE_ITEMS ? ["twin"] : []), ...(real("learner") >= MIN_MODE_ITEMS ? ["learner"] : [])];
  if (modes.length !== 2) reasons.push(`both modes required: ${real("trainer")} trainer and ${real("learner")} learner session lines; each side needs ${MIN_MODE_ITEMS}`);
  const { inv, sessions } = await scenarioFiles(io, user, scenario);
  const missing = sessions.filter((s) => !items.some((x) => x.metadata.source === s.id));
  if (missing.length) reasons.push(`sessions without evidence: ${missing.map((s) => s.id).join(", ")}`);
  const redact = redactor(names);
  const sample = await Promise.all([...items].sort(() => Math.random() - 0.5).slice(0, 5).map(async (it) => {
    const prev = it.metadata.ref == null ? null : parseDoc((await readSourceText(io, user, inv, it.metadata.source)).text).turns[it.metadata.ref - 1];
    return { id: it.id, action: it.metadata.action, part: it.metadata.part, role: it.role, before: prev ? redact(`${prev.speaker}: ${prev.text}`) : null, text: it.text, context: it.context };
  }));
  const evidence = [...new Set(items.map((x) => `${x.role}.${x.metadata.part}.${x.metadata.action}`))].map((action) => {
    const rows = items.filter((x) => `${x.role}.${x.metadata.part}.${x.metadata.action}` === action);
    return { action, lines: rows.length, sessions: new Set(rows.filter((x) => x.metadata.kind === "session").map((x) => x.metadata.source)).size };
  });
  return { pass: !reasons.length, reasons: [...new Set(reasons)], modes, items: { trainer: real("trainer"), learner: real("learner"), docs: items.length - real("trainer") - real("learner") }, evidence, sample };
}

export type Stage = "pattern" | "skill" | "items";

/** Without a scenario: stage 1. With one: the stages asked for, in order; "all" is the final validation. */
export async function check(io: Io, user: string, scenario?: string, stage: Stage | "all" = "all") {
  if (!scenario) return checkScout(io, user);
  const run = { pattern: checkPattern, skill: checkSkill, items: checkItems };
  const stages: Stage[] = stage === "all" ? ["pattern", "skill", "items"] : [stage];
  const out: Record<string, unknown> = {};
  const reasons: string[] = [];
  for (const s of stages) {
    const r = await run[s](io, user, scenario);
    out[s] = r;
    reasons.push(...r.reasons.map((x) => (stages.length > 1 ? `${s}: ${x}` : x)));
    if (stage === "all" && "unsupported_moves" in r && Array.isArray(r.unsupported_moves) && r.unsupported_moves.length)
      reasons.push(`skill: unsupported moves: ${r.unsupported_moves.join(", ")}`);
  }
  return { pass: !reasons.length, reasons, ...(stages.length === 1 ? out[stages[0]] as object : out) };
}

/** The rules every check enforces, written from the same constants, so the agent knows them before its first build. */
export function requirementsText() {
  const observed = PATTERN_SECTIONS.filter((h) => h !== "## From the method docs" && h !== "## Gaps");
  return `# Requirements build_scenario and check enforce

Know these before you read anything. Every number is a hard limit in code.

## Plan
- Scenario \`id\`: kebab-case, at most 64 characters. If \`spec\` is set, write \`specs/<id>.md\` first.
- At least ${MIN_SESSIONS} sessions. Each session \`id\` is the exact file id of a two-person recording from \`files\`.
- \`trainer\` and \`learner\` use the speaker labels in that file; no label on both sides.
- \`plays\`: one entry for every listed label and no other label, saying the part that person plays (coach, client, agent, observer).
- \`spans\`: inclusive turn ranges inside the file, covering only the practice. Each session needs at least ${MIN_PRACTICE.turns} turns inside its spans, at least ${MIN_PRACTICE.perSide} from each side.

## Items (evidence)
- At least ${MIN_MODE_ITEMS} session items for the trainer side and ${MIN_MODE_ITEMS} for the learner side; at least 1 item from every planned session. Collect about 20% extra, so a few rejected items do not drop you below the minimum.
- Each item: \`source\` (file id), \`n\` (turn inside that session's spans), \`role\` (the side of that turn's speaker), \`part\` (copied exactly from that side's \`plays\` value), \`action\` (kebab-case, one concrete act), \`context\` (1 to ${MAX_WORDS.context} words, no personal details).
- The line must have at least ${MIN_ITEM_WORDS} words. Skip fillers instead of trimming them.
- Prefer whole turns. Use \`start\`/\`end\` only with words copied exactly from that turn.
- No two items with the same text or overlapping parts of one turn. At most ${MAX_ITEMS} items per side and action.
- Method files: trainer side only, with \`quote\` copied exactly.

## patterns.md
- Every section: ${PATTERN_SECTIONS.join(", ")}.
- At most ${MAX_WORDS.patterns} words, refs not counted. Cite \`[[<file id>#<turn>]]\` for session turns and \`[[<file id>]]\` for method files; cite every session at least once.
- Every bullet that cites a session under ${observed.join(", ")} ends with "(k of N sessions)", where N is the session count and k distinct sessions are cited on that line. Never write a bare "(k of N)".

## SKILL.md and scenario.json
- \`skill\`: \`scenario\` equals the plan id; \`description\` at most 1024 characters, no angle brackets; ${STEPS.min} to ${STEPS.max} steps with unique kebab-case ids.
- Each step: \`parts\` {trainer, learner} copied from \`plays\`; at most ${MAX_MOVES} trainer moves and ${MAX_MOVES} learner moves.
- A move id must equal an item \`action\` with the same side and part. A move needs at least ${MIN_MOVE_ITEMS} items; otherwise add it to the step's \`low_evidence\` and mark its line "(low evidence)".
- \`body\` is Markdown with no front matter and every section: ${SKILL_SECTIONS.join(", ")}. At most ${MAX_WORDS.skill} words, no refs.
- Under "## Steps", each step has a "### ... \`<step id>\`" heading, and each of its moves has one line "- \`<move>\`: definition" of at most ${MAX_MOVE_DEF_WORDS} words.
- Counts are copied exactly from patterns.md as "(k of N sessions)".
- Every "## Rules" bullet ends with a count from patterns.md or "(method docs)". "Always", "never", "every" or "must" needs a count of at least ${MIN_RULE_SESSIONS} sessions.

## Everywhere
No names of people or companies, emails, phone numbers or links in anything you write; use roles or [name]. Pass the names you saw in \`names\`.
`;
}

