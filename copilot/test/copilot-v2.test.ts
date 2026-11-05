// Copilot v2 (plans/copilot-v2.md): skill updates on top of the published version, the studio client's org scoping,
// knowledge re-sync. Run: bun test test/copilot-v2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, holdsPart, mergeWithBase, rebaseAfterPublish, saveTwinSkill } from "../agent/lib/twin-skill.ts";
import { outPath } from "../agent/lib/paths.ts";
import { studio } from "../agent/lib/studio.ts";
import { ensureSynced } from "../agent/lib/ingest.ts";
import { outputScope } from "../agent/lib/session-io.ts";
import { sessionPrincipal } from "../agent/lib/tenant.ts";

const item = (id, step, text, source = "doc1") => ({
  id, role: "trainer", context: "c", text,
  metadata: { skill_id: "objection-handling", step, type: "decision", source, kind: "doc", ref: null, words: text.split(" ").length },
});
const base = {
  slug: "olga-objection-handling", version: 1, skillId: "objection-handling", name: "Objection Handling",
  items: [item("a", "too-expensive", "I never defend the price, I clarify what they mean"), item("b", "wait", "When they want to wait I build the cost chain")],
};

test("a redacted stored item still matches its source turn", () => {
  assert.equal(holdsPart("Call Maria now and ask what she means", "Call Maria now"), true);
  assert.equal(holdsPart("Call Maria now and ask what she means", "Call [name] now and ask"), true);
  assert.equal(holdsPart("Call Maria now and ask what she means", "Call [name] later"), false);
});

test("an update keeps the loaded items, drops removed ones, adds new ones once", () => {
  const added = [item("c", "too-expensive", "I ask what the money is really protecting", "doc2"), item("dup", "wait", "When they want to wait I build the cost chain")];
  const merged = mergeWithBase(base, "objection-handling", added, [{ id: "b", reason: "superseded by the workbook" }]);
  // "dup" repeats b's text, but b was removed, so it comes back as a new item.
  assert.deepEqual(merged.items.map((x) => x.id), ["a", "c", "dup"]);
  assert.equal(merged.changes.kept, 1);
  assert.deepEqual(merged.changes.removed, [{ id: "b", reason: "superseded by the workbook" }]);
  assert.deepEqual(merged.changes.added.map((x) => x.id), ["c", "dup"]);
  assert.deepEqual(merged.changes.newSources, ["doc2"]);
  assert.equal(merged.changes.skipped.length, 0);
});

test("a new item repeating a kept one is skipped, not doubled", () => {
  const merged = mergeWithBase(base, "objection-handling", [item("x", "wait", "When they want to wait I build the cost chain")], []);
  assert.deepEqual(merged.items.map((x) => x.id), ["a", "b"]);
  assert.equal(merged.changes.skipped[0].id, "x");
});

test("an update can't change the skill id or remove an unknown item", () => {
  assert.match(mergeWithBase(base, "objections-v2", [], []).rejected[0], /keeps the skill id "objection-handling"/);
  assert.match(mergeWithBase(base, "objection-handling", [], [{ id: "zzz", reason: "gone" }]).rejected[0], /not one of the loaded items/);
});

test("studio calls carry the session's org and trainer, never the model's", async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  const ctx = { session: { auth: { current: { principalType: "organization", principalId: "org-olga", attributes: { userId: "u1" } } } } };
  await studio(ctx, { action: "list", orgId: "someone-else" }, fetcher, { STUDIO_URL: "https://dash.example", SCENARIO_INGEST_SECRET: "s" });
  assert.equal(calls[0].url, "https://dash.example/api/internal/copilot-studio");
  assert.equal(calls[0].init.headers["x-trainertwin-org-id"], "org-olga");
  assert.equal(calls[0].init.headers["x-trainertwin-user-id"], "u1");
  await assert.rejects(studio({ session: { auth: { current: null } } }, { action: "list" }, fetcher, { STUDIO_URL: "x", SCENARIO_INGEST_SECRET: "s" }), /not attached/);
  await assert.rejects(studio({ session: { auth: { current: { principalType: "organization", principalId: "o", attributes: {} } } } }, { action: "list" }, fetcher, { STUDIO_URL: "x", SCENARIO_INGEST_SECRET: "s" }), /signed-in trainer/);
});

test("outputs of a studio session are scoped to its org", () => {
  assert.equal(outputScope({ session: { auth: { current: { principalType: "organization", principalId: "org-olga" } } } }), "org-olga");
  assert.equal(outputScope({ session: { auth: { current: null } } }), undefined);
});

test("the sandbox re-syncs when the knowledge base changes mid-chat", async () => {
  const files = new Map();
  let version = "v1";
  let docs = [{ path: "data/uploads/Workbook [doc1].md", text: "---\ntitle: Workbook\n---\nA method doc.\n" }];
  let pulls = 0;
  const io = {
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    list: async () => [], grep: async () => [],
    sources: async () => { pulls++; return docs; },
    sourcesVersion: async () => version,
  };
  assert.deepEqual((await ensureSynced(io, "olga")).map((f) => f.id), ["doc1"]);
  await ensureSynced(io, "olga");
  assert.equal(pulls, 1); // same version: cached
  docs = [...docs, { path: "data/uploads/Session 2 [doc2].md", text: "---\ntitle: Session 2\n---\nNew.\n" }];
  version = "v2";
  assert.deepEqual((await ensureSynced(io, "olga")).map((f) => f.id).sort(), ["doc1", "doc2"]);
  assert.equal(pulls, 2);
});

test("a conversation stays with the org that started it", async () => {
  const olga = { principalType: "organization", principalId: "org-olga", attributes: { userId: "u1" } };
  const acme = { principalType: "organization", principalId: "org-acme", attributes: { userId: "u1" } };
  // Same org: the starter's org, the current caller's attributes.
  assert.deepEqual(sessionPrincipal({ session: { auth: { current: { ...olga, attributes: { userId: "u2" } }, initiator: olga } } }), { ...olga, attributes: { userId: "u2" } });
  // Another org continuing it: refused everywhere the copilot touches the studio.
  const crossed = { session: { auth: { current: acme, initiator: olga } } };
  assert.throws(() => sessionPrincipal(crossed), /belongs to another organization/);
  assert.throws(() => outputScope(crossed), /belongs to another organization/);
  const fetcher = async () => { throw new Error("must not be called"); };
  await assert.rejects(studio(crossed, { action: "list" }, fetcher, { STUDIO_URL: "x", SCENARIO_INGEST_SECRET: "s" }), /belongs to another organization/);
  // Non-studio sessions (eve dev) pass through.
  assert.equal(sessionPrincipal({ session: { auth: { current: null } } }), null);
});

test("a second update in the same conversation builds on what was just published, not on what was loaded", async () => {
  const files = new Map();
  const io = { read: async (p) => files.get(p) ?? null, write: async (p, c) => void files.set(p, c), list: async () => [], grep: async () => [] };
  // Update 1: loaded v1 (a, b) + c, published as v2. The sandbox's items.json is what was published.
  const first = mergeWithBase(base, "objection-handling", [item("c", "too-expensive", "I ask what the money is really protecting", "doc2")], []);
  files.set(outPath("olga", "twin-skills/objection-handling/items.json"), JSON.stringify(first.items));
  files.set(outPath("olga", "twin-skills/objection-handling/skill.json"), JSON.stringify({ name: "Objection Handling" }));
  const rebased = await rebaseAfterPublish(io, "olga", "objection-handling", { slug: "olga-objection-handling", version: 2 });
  assert.equal(rebased.version, 2);
  assert.equal(files.get(outPath("olga", "twin-skills/objection-handling/changes.json")), "null\n");
  // Update 2: "also add d" keeps c from update 1.
  const second = mergeWithBase(rebased, "objection-handling", [item("d", "wait", "I let the silence work for me", "doc3")], []);
  assert.deepEqual(second.items.map((x) => x.id), ["a", "b", "c", "d"]);
  assert.deepEqual(second.changes.base, { slug: "olga-objection-handling", version: 2 });
});

test("an update's edits each match the published text exactly once, in order; otherwise nothing applies", () => {
  const text = "## When they say it's too expensive\nI clarify what they mean.\n## When they want to wait\nI build the cost chain.\n";
  const edit = (find, replace) => ({ file: "SKILL.md", find, replace, why: "new session with Osama" });
  assert.deepEqual(applyEdits(text, [edit("I clarify what they mean.", "I clarify what they mean, then ask what the money protects.")]), {
    text: "## When they say it's too expensive\nI clarify what they mean, then ask what the money protects.\n## When they want to wait\nI build the cost chain.\n",
  });
  assert.match(applyEdits(text, [edit("I never defend the price", "x")]).rejected[0], /not in the loaded text/);
  assert.match(applyEdits(text, [edit("## When", "x")]).rejected[0], /more than once/);
  // Later edits see earlier ones: a heading renamed, then text under the new name.
  const two = applyEdits(text, [edit("## When they want to wait", "## When they want to wait for prices to drop"), edit("prices to drop\nI build", "prices to drop\nFirst I ask why, then I build")]);
  assert.match(two.text, /First I ask why, then I build the cost chain/);
});

test("an update refuses whole texts; a new skill refuses edits; after a publish the base keeps the published texts", async () => {
  const files = new Map();
  const io = { read: async (p) => files.get(p) ?? null, write: async (p, c) => void files.set(p, c), list: async () => [], grep: async () => [] };
  const head = { skill: "objection-handling", name: "Objection Handling", description: "When clients push back", situations: [] };
  const fresh = await saveTwinSkill(io, "olga", { user: "olga", skill: head, items: [], edits: [{ file: "SKILL.md", find: "a", replace: "b", why: "because" }] });
  assert.match(fresh.rejected[0], /a new skill needs items|edits are for updates/);
  // Published: rebase records the published body and patterns.
  files.set(outPath("olga", "twin-skills/objection-handling/SKILL.md"), "---\nname: objection-handling\n---\n## Too expensive\nI clarify.\n");
  files.set(outPath("olga", "twin-skills/objection-handling/patterns.md"), "# Patterns\n");
  files.set(outPath("olga", "twin-skills/objection-handling/items.json"), "[]");
  const rebased = await rebaseAfterPublish(io, "olga", "objection-handling", { slug: "olga-objection-handling", version: 3 });
  assert.equal(rebased.body, "## Too expensive\nI clarify.");
  assert.equal(rebased.patterns, "# Patterns\n");
  const whole = await saveTwinSkill(io, "olga", { user: "olga", skill: head, items: [], body: "## Rewritten", patterns: "# New" });
  assert.match(whole.rejected[0], /This is an update: change SKILL.md and patterns.md with `edits`/);
});
