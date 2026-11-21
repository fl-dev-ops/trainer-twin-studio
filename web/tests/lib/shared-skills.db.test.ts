import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService } from "@/lib/main-collection";
import * as database from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { RoleplayBuilder } from "@/lib/roleplay/skill";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const files = new Map<string, string>();
let storageFailure = false;
const putObject = mock(async (key: string, body: string) => {
  if (storageFailure) throw new Error("S3 publication failed");
  files.set(key, body);
});
const getObjectText = mock(async (key: string) => {
  const body = files.get(key);
  if (body === undefined) throw new Error(`Missing test object: ${key}`);
  return body;
});
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({ ...s3, s3Configured: true, putObject, getObjectText }));
const { ingestScenario, ingestTwinSkill, saveRoleplay } = await import("@/lib/scenario-ingest");
const { readSkillRegistry, skillFiles, skillPackageHash } = await import("@/lib/skills");

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!localMinutesDb)("Phase 1 shared skill publishing (real Postgres)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let writeSkill: ReturnType<typeof spyOn<typeof MainCollectionService, "writeSkillItems">>;
  let writeScenario: ReturnType<typeof spyOn<typeof MainCollectionService, "writeScenarioItems">>;
  let prune: ReturnType<typeof spyOn<typeof MainCollectionService, "pruneScenarioItems">>;
  const lockSpies: { mockRestore(): void }[] = [];

  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture();
    await f.create(); await other.create();
    files.clear(); storageFailure = false; putObject.mockClear(); getObjectText.mockClear();
    writeSkill = spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _version, _scenario, items) => items.length);
    writeScenario = spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, _version, items) => items.length);
    prune = spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const spy of lockSpies.splice(0).reverse()) spy.mockRestore();
    writeSkill.mockRestore(); writeScenario.mockRestore(); prune.mockRestore();
    for (const fixture of [other, f]) {
      await db.agent.updateMany({ where: { orgId: fixture.org.id }, data: { primarySkillId: null } });
      await db.skill.updateMany({ where: { orgId: fixture.org.id }, data: { currentVersionId: null } });
      await db.agentSkillVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await db.skillVersionSource.deleteMany({ where: { orgId: fixture.org.id } });
      await db.skillVersion.deleteMany({ where: { skill: { orgId: fixture.org.id } } });
      await db.skill.deleteMany({ where: { orgId: fixture.org.id } });
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
  });

  const builder = (): RoleplayBuilder => ({
    name: "Shared skill practice", persona: f.org.slug,
    situation: { scenario: "A buyer is deciding whether to meet.", learnerRole: "Advisor" },
    difficulty: "medium", opening: "Why should I meet you?", exampleLines: ["I need more time."],
    guardedIf: [], opensUpIf: [], learnerGoals: ["Agree a next step"],
    rubric: [{ name: "Understands the buyer", points: 100 }],
  });
  const authored = (skill = "# Authored practice\n") => ({
    personaSlug: f.org.slug, kind: "ROLEPLAY" as const, skill,
    scenario: {
      scenario: "authored-practice", name: "Authored practice", description: "Practise a decision",
      trainer_role: "Client", learner_role: "Advisor",
      steps: [{ id: "opening", name: "Opening", trainer_moves: ["answer"], learner_moves: ["ask"] }],
    },
    items: [{ id: "opening", role: "trainer" as const, context: "First turn", text: "What do you suggest?", metadata: { step: "opening" } }],
    patterns: "# Evidence\nAn exact source excerpt.\n",
  });
  const registry = async (slug: string) => {
    const skill = await readSkillRegistry(f.org.id, slug);
    const versions = await db.skillVersion.findMany({ where: { skillId: skill.id }, orderBy: { version: "desc" }, take: 100 });
    return { ...skill, versions };
  };
  const current = async (slug: string) => {
    const skill = await registry(slug);
    return db.skillVersion.findUniqueOrThrow({ where: { id: skill.currentVersionId! } });
  };
  const agent = (slug: string) => db.agent.findUniqueOrThrow({ where: { slug } });
  const pauseFinalizations = (slug: string, finalCalls: readonly number[] = [2]) => {
    const pauses = finalCalls.map(() => ({ entered: barrier(), release: barrier() }));
    const lock = database.withLock;
    let calls = 0;
    lockSpies.push(spyOn(database, "withLock").mockImplementation(async (keys, work, options) => {
      expect(keys).toEqual([`skill-ownership:${f.org.id}`, `agent:${slug}`]);
      const call = ++calls;
      const index = finalCalls.indexOf(call);
      if (index !== -1) {
        const pause = pauses[index];
        pause.entered.resolve();
        await pause.release.promise;
      }
      return lock(keys, work, options);
    }));
    return pauses;
  };

  test.each(["builder", "authored", "twin", "legacy-twin"] as const)("%s publishes a ready registered package and links primarySkill in the same org", async (kind) => {
    const input = authored();
    const saved = kind === "builder" ? await saveRoleplay(f.org.id, builder(), f.roleplay.slug)
      : kind === "twin" ? await ingestTwinSkill(f.org.id, {
        personaSlug: f.org.slug, skill: "# Decision skill\n",
        manifest: { skill: "decision-skill", name: "Decision skill", description: "Make a decision", situations: [{ id: "decide", name: "Decide" }] },
        items: input.items,
      })
      : await ingestScenario(f.org.id, { ...input, kind: kind === "legacy-twin" ? "TWIN" : "ROLEPLAY" });
    const skill = await registry(saved.slug);
    const version = await current(saved.slug);
    const row = await agent(saved.slug);
    expect(skill).toMatchObject({ orgId: f.org.id, ownerSlug: saved.slug, currentVersionId: version.id });
    expect(row).toMatchObject({ orgId: f.org.id, primarySkillId: skill.id, kind: kind.includes("twin") ? "TWIN" : "ROLEPLAY" });
    expect(version).toMatchObject({
      skillId: skill.id, version: 1, format: kind === "builder" ? "builder-roleplay" : kind === "authored" ? "authored-roleplay" : kind,
      status: "ready", indexStatus: "ready", artifacts: saved.artifacts,
    });
    expect(await db.agentSkillVersion.findMany({ where: { agentId: row.id } })).toEqual([
      expect.objectContaining({ orgId: f.org.id, agentVersion: saved.version, skillVersionId: version.id }),
    ]);
    const packageFiles = skillFiles(version.files);
    expect(Object.keys(packageFiles).sort()).toEqual(kind === "twin"
      ? ["SKILL.md", "items.json", "skill.json"] : kind === "builder"
        ? ["SKILL.md", "items.json", "scenario.json"] : ["SKILL.md", "items.json", "patterns.md", "scenario.json"]);
    for (const [name, bytes] of Object.entries(packageFiles)) expect(files.get(`${saved.artifacts}/${name}`)).toBe(bytes);
    expect(writeSkill).toHaveBeenCalledWith(f.org.id, version.id, expect.any(String), JSON.parse(packageFiles["items.json"]), saved.artifacts);
    expect(writeScenario).toHaveBeenCalledWith(f.org.id, saved.slug, expect.any(String), saved.version, JSON.parse(packageFiles["items.json"]));
  });

  test("version files and hash preserve exact bytes, include patterns and items, and never overwrite previous packages", async () => {
    const input = authored("---\nname: exact\n---\n# Exact bytes\r\n  Keep whitespace.\n");
    const saved = await ingestScenario(f.org.id, input);
    const first = await current(saved.slug);
    const snapshot = new Map(files);
    const packageFiles = skillFiles(first.files);
    const expected = createHash("sha256").update(JSON.stringify([
      "authored-roleplay", Object.keys(packageFiles).sort().map((name) => [name, packageFiles[name]]),
    ])).digest("hex");
    expect(first.contentHash).toBe(expected);
    expect(first.skillText).toBe(input.skill);
    expect(packageFiles["SKILL.md"]).toBe(input.skill);
    expect(packageFiles["patterns.md"]).toBe(input.patterns);
    expect(first.contentHash).toBe(skillPackageHash("authored-roleplay", Object.fromEntries(Object.entries(packageFiles).reverse())));
    expect(skillPackageHash("twin", packageFiles)).not.toBe(first.contentHash);
    const withoutPatterns = Object.fromEntries(Object.entries(packageFiles).filter(([name]) => name !== "patterns.md"));
    expect(skillPackageHash("authored-roleplay", withoutPatterns)).not.toBe(skillPackageHash("authored-roleplay", { ...withoutPatterns, "patterns.md": "" }));
    for (const name of ["SKILL.md", "scenario.json", "items.json", "patterns.md"]) {
      expect(skillPackageHash("authored-roleplay", { ...packageFiles, [name]: `${packageFiles[name]}\n` })).not.toBe(first.contentHash);
    }
    await ingestScenario(f.org.id, { ...input, patterns: `${input.patterns}New evidence.\n` });
    const second = await current(saved.slug);
    expect(second.version).toBe(first.version + 1);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.artifacts).not.toBe(first.artifacts);
    expect(await db.skillVersion.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);
    for (const [key, bytes] of snapshot) expect(files.get(key)).toBe(bytes);
  });

  test("zero items publishes an explicit empty items file and ready empty index", async () => {
    const saved = await ingestScenario(f.org.id, { ...authored(), items: [] });
    const version = await current(saved.slug);
    expect(version).toMatchObject({ itemCount: 0, status: "ready", indexStatus: "ready" });
    expect(files.get(`${version.artifacts}/items.json`)).toBe("[]\n");
    expect(writeSkill).toHaveBeenCalledWith(f.org.id, version.id, "authored-practice", [], saved.artifacts);
  });

  test("an identical publish is a no-op with no S3, skill-index, scenario-index or prune rewrites", async () => {
    const input = authored();
    const first = await ingestScenario(f.org.id, input);
    const original = await current(first.slug);
    const counts = [putObject.mock.calls.length, getObjectText.mock.calls.length, writeSkill.mock.calls.length, writeScenario.mock.calls.length, prune.mock.calls.length];
    const again = await ingestScenario(f.org.id, input);
    expect(again).toMatchObject({ version: first.version, artifacts: first.artifacts, created: false });
    expect((await registry(first.slug)).versions).toHaveLength(1);
    expect(await current(first.slug)).toEqual(original);
    expect([putObject.mock.calls.length, getObjectText.mock.calls.length, writeSkill.mock.calls.length, writeScenario.mock.calls.length, prune.mock.calls.length]).toEqual(counts);
  });

  test("scoring-only builder edits change After without advancing or rewriting SkillVersion", async () => {
    const input = builder();
    const saved = await saveRoleplay(f.org.id, input, f.roleplay.slug);
    const original = await current(saved.slug);
    const writes = putObject.mock.calls.length;
    await saveRoleplay(f.org.id, { ...input, learnerGoals: ["Uncover the real concern"], rubric: [{ name: "Listens carefully", points: 80 }] }, saved.slug);
    expect(await current(saved.slug)).toMatchObject({ id: original.id, version: original.version, contentHash: original.contentHash, files: original.files, manifest: original.manifest, skillText: original.skillText, artifacts: original.artifacts });
    expect((await registry(saved.slug)).versions).toHaveLength(1);
    expect((await agent(saved.slug)).data).toMatchObject({ after: { goals: ["Uncover the real concern"], rubric: [{ name: "Listens carefully", points: 80 }] } });
    expect(putObject.mock.calls.length).toBe(writes);
    expect(writeSkill).toHaveBeenCalledTimes(1);
    const changed = await agent(saved.slug);
    expect(changed.version).toBeGreaterThan(saved.version);
    expect(await db.agentSkillVersion.findMany({
      where: { agentId: changed.id }, orderBy: { agentVersion: "asc" },
    })).toEqual([
      expect.objectContaining({ orgId: f.org.id, agentVersion: saved.version, skillVersionId: original.id }),
      expect.objectContaining({ orgId: f.org.id, agentVersion: changed.version, skillVersionId: original.id }),
    ]);
  });

  test("changing the assigned persona does not advance SkillVersion or rewrite package files", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    const original = await current(saved.slug);
    const persona = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Another client", data: {} } });
    const writes = putObject.mock.calls.length;
    await ingestScenario(f.org.id, { ...authored(), personaSlug: persona.slug });
    expect(await current(saved.slug)).toMatchObject({ id: original.id, version: original.version, contentHash: original.contentHash, files: original.files, manifest: original.manifest, skillText: original.skillText, artifacts: original.artifacts });
    expect((await registry(saved.slug)).versions).toHaveLength(1);
    expect(await agent(saved.slug)).toMatchObject({ personaId: persona.id });
    expect(putObject.mock.calls.length).toBe(writes);
    expect(writeSkill).toHaveBeenCalledTimes(1);
    const changed = await agent(saved.slug);
    expect(changed.version).toBeGreaterThan(saved.version);
    expect(await db.agentSkillVersion.findMany({
      where: { agentId: changed.id }, orderBy: { agentVersion: "asc" },
    })).toEqual([
      expect.objectContaining({ orgId: f.org.id, agentVersion: saved.version, skillVersionId: original.id }),
      expect.objectContaining({ orgId: f.org.id, agentVersion: changed.version, skillVersionId: original.id }),
    ]);
  });

  test.each(["first publication", "update"] as const)("concurrent identical %s converges on one package, pointer and Agent version", async (mode) => {
    if (mode === "update") await ingestScenario(f.org.id, authored());
    const slug = `${f.org.slug}-authored-practice`;
    const [pause] = pauseFinalizations(slug);
    const pending = Promise.allSettled([ingestScenario(f.org.id, authored("# Changed\n"))]);
    let second: Awaited<ReturnType<typeof ingestScenario>>;
    try {
      await pause.entered.promise;
      second = await ingestScenario(f.org.id, authored("# Changed\n"));
    } finally {
      pause.release.resolve();
    }
    const [first] = await pending;
    expect(first.status).toBe("fulfilled");
    if (first.status === "rejected") throw first.reason;
    const results = [first.value, second];
    expect(results[0].version).toBe(results[1].version);
    expect(results[0].artifacts).toBe(results[1].artifacts);
    const skill = await registry(results[0].slug);
    expect(skill.versions).toHaveLength(mode === "update" ? 2 : 1);
    const version = await current(results[0].slug);
    expect(version).toMatchObject({ version: mode === "update" ? 2 : 1, status: "ready", skillText: "# Changed\n" });
    expect(await agent(results[0].slug)).toMatchObject({ version: results[0].version, primarySkillId: skill.id, data: { artifacts: version.artifacts, skill: "# Changed\n" } });
    expect(writeSkill).toHaveBeenCalledTimes(mode === "update" ? 2 : 1);
  });

  test("S3 readback mismatch refuses readiness, leaves previous current and records the failed package", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    const original = await current(saved.slug);
    getObjectText.mockResolvedValueOnce("corrupted object bytes");
    await expect(ingestScenario(f.org.id, authored("# Must verify bytes\n"))).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    const skill = await registry(saved.slug);
    expect(skill.currentVersionId).toBe(original.id);
    expect(skill.versions[0]).toMatchObject({ status: "failed", skillText: "# Must verify bytes\n" });
    expect(writeSkill).toHaveBeenCalledTimes(1);
    expect((await agent(saved.slug)).data).toMatchObject({ skill: original.skillText, artifacts: original.artifacts });
  });

  test.each(["S3", "skill index", "scenario index"] as const)("%s failure preserves the previous current package and exposes failed publication; retry reuses its id", async (boundary) => {
    const saved = await ingestScenario(f.org.id, authored());
    const original = await current(saved.slug);
    const originalAgent = await agent(saved.slug);
    const input = authored("# Retry this exact package\n");
    if (boundary === "S3") storageFailure = true;
    else if (boundary === "skill index") writeSkill.mockRejectedValueOnce(new Error("Skill index publication failed"));
    else writeScenario.mockRejectedValueOnce(new Error("Scenario index publication failed"));
    await expect(ingestScenario(f.org.id, input)).rejects.toThrow("publication failed");
    const failedRegistry = await registry(saved.slug);
    expect(failedRegistry.currentVersionId).toBe(original.id);
    expect(await agent(saved.slug)).toEqual(originalAgent);
    expect(failedRegistry.versions).toHaveLength(2);
    const failed = failedRegistry.versions[0];
    expect(failed).toMatchObject({ status: "failed", indexStatus: "failed", skillText: input.skill });
    expect(failed.failure).toContain("publication failed");
    storageFailure = false;
    const retry = await ingestScenario(f.org.id, input);
    const active = await current(saved.slug);
    expect(active).toMatchObject({ id: failed.id, version: failed.version, artifacts: retry.artifacts, status: "ready", indexStatus: "ready", failure: null });
    expect(retry.artifacts).not.toBe(failed.artifacts);
    expect(retry.artifacts.startsWith(`${failed.artifacts}/attempt-`)).toBe(true);
    for (const [name, bytes] of Object.entries(skillFiles(active.files))) expect(files.get(`${retry.artifacts}/${name}`)).toBe(bytes);
    expect(writeSkill).toHaveBeenLastCalledWith(f.org.id, failed.id, "authored-practice", input.items, retry.artifacts);
    expect((await registry(saved.slug)).versions).toHaveLength(2);
  });

  test("concurrent different publishes cannot stale-override the newer package and their files stay isolated", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    const [pause] = pauseFinalizations(saved.slug);
    const stale = Promise.allSettled([ingestScenario(f.org.id, authored("# Older in-flight publication\n"))]);
    let newer: Awaited<ReturnType<typeof ingestScenario>>;
    try {
      await pause.entered.promise;
      newer = await ingestScenario(f.org.id, authored("# Newer publication\n"));
    } finally {
      pause.release.resolve();
    }
    const [outcome] = await stale;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      const error: unknown = outcome.reason;
      expect(error).toMatchObject({ code: "skill_publication_superseded", status: 409 });
    }
    const skill = await registry(saved.slug);
    expect(skill.versions).toHaveLength(3);
    expect(new Set(skill.versions.map((version) => version.artifacts)).size).toBe(3);
    const version = await current(saved.slug);
    expect(version).toMatchObject({ skillText: "# Newer publication\n", artifacts: newer.artifacts });
    expect(await agent(saved.slug)).toMatchObject({ version: newer.version, data: { skill: "# Newer publication\n", artifacts: newer.artifacts } });
    for (const published of skill.versions) {
      if (published.skillText === "# Older in-flight publication\n") {
        expect(published.status).toBe("failed");
        expect([...files.keys()].filter((key) => key.startsWith(`${published.artifacts}/`))).toEqual([]);
      } else {
        for (const [name, bytes] of Object.entries(skillFiles(published.files))) expect(files.get(`${published.artifacts}/${name}`)).toBe(bytes);
      }
    }
  });

  test("readSkillRegistry refuses another org's slug as not_found", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    await expect(readSkillRegistry(other.org.id, saved.slug)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test.each(["persona", "scoring", "provenance"] as const)("same-package pending publishes with different %s reserve distinct generations and only the newer intent wins", async (difference) => {
    const persona = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second client", data: {} } });
    const twinInput = {
      personaSlug: f.org.slug, skill: "# Shared pending package\n", items: authored().items,
      manifest: { skill: "intent-skill", name: "Intent skill", description: "Practise intent", situations: [{ id: "decide", name: "Decide" }] },
    };
    const slug = difference === "scoring" ? f.roleplay.slug : `${f.org.slug}-${difference === "provenance" ? "intent-skill" : "authored-practice"}`;
    const [pause] = pauseFinalizations(slug);
    const publish = (newer: boolean) => difference === "scoring"
      ? saveRoleplay(f.org.id, { ...builder(), learnerGoals: [newer ? "New scoring intent" : "Old scoring intent"] }, slug)
      : difference === "provenance"
        ? ingestTwinSkill(f.org.id, { ...twinInput, changes: { summary: newer ? "New provenance intent" : "Old provenance intent" } })
        : ingestScenario(f.org.id, { ...authored("# Shared pending package\n"), personaSlug: newer ? persona.slug : f.org.slug });
    const pending = Promise.allSettled([publish(false)]);
    let firstGeneration = 0; let firstHash: string | null = null;
    let packageId = ""; let contentHash = ""; let saved: Awaited<ReturnType<typeof publish>>;
    try {
      await pause.entered.promise;
      const first = await registry(slug);
      firstGeneration = first.generation; firstHash = first.publicationHash;
      packageId = first.versions[0].id; contentHash = first.versions[0].contentHash;
      expect(first.versions[0]).toMatchObject({ status: "pending", publicationGeneration: firstGeneration });
      saved = await publish(true);
      const next = await registry(slug);
      expect(next.generation).toBeGreaterThan(firstGeneration);
      expect(next.publicationHash).not.toBe(firstHash);
      expect(next.versions).toHaveLength(1);
      expect(next.versions[0]).toMatchObject({ id: packageId, contentHash, status: "ready", publicationGeneration: next.generation });
    } finally {
      pause.release.resolve();
    }
    const [outcome] = await pending;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      const error: unknown = outcome.reason;
      expect(error).toMatchObject({ code: "skill_publication_superseded", status: 409 });
    }
    const row = await agent(slug);
    expect(row.version).toBe(saved.version);
    expect((await registry(slug)).currentVersionId).toBe(packageId);
    expect(await current(slug)).toMatchObject({ status: "ready", failure: null });
    if (difference === "persona") expect(row.personaId).toBe(persona.id);
    if (difference === "scoring") expect(row.data).toMatchObject({ after: { goals: ["New scoring intent"] } });
    if (difference === "provenance") expect(files.get(`${saved.artifacts}/changes.json`)).toBe(JSON.stringify({ summary: "New provenance intent" }, null, 1) + "\n");
    expect(writeSkill).toHaveBeenCalledTimes(1);
  });

  test("an in-flight idempotent duplicate refuses after newer intent is reserved even while the duplicate package is still current", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    const duplicateInput = authored("# Duplicate pending intent\n");
    const [duplicatePause, newerPause] = pauseFinalizations(saved.slug, [2, 6]);
    const duplicate = Promise.allSettled([ingestScenario(f.org.id, duplicateInput)]);
    let newer: Promise<PromiseSettledResult<Awaited<ReturnType<typeof ingestScenario>>>[]> | undefined;
    try {
      await duplicatePause.entered.promise;
      const duplicateGeneration = (await registry(saved.slug)).generation;
      await ingestScenario(f.org.id, duplicateInput);
      const duplicateVersion = await current(saved.slug);
      expect(duplicateVersion.skillText).toBe(duplicateInput.skill);
      newer = Promise.allSettled([ingestScenario(f.org.id, authored("# Newer accepted intent\n"))]);
      await newerPause.entered.promise;
      const reserved = await registry(saved.slug);
      expect(reserved.currentVersionId).toBe(duplicateVersion.id);
      expect(reserved.generation).toBeGreaterThan(duplicateGeneration);
      expect((await agent(saved.slug)).data).toMatchObject({ skill: duplicateInput.skill });
      duplicatePause.release.resolve();
      const [outcome] = await duplicate;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        const error: unknown = outcome.reason;
        expect(error).toMatchObject({ code: "skill_publication_superseded", status: 409 });
      }
      expect((await registry(saved.slug)).currentVersionId).toBe(duplicateVersion.id);
      expect(writeSkill).toHaveBeenCalledTimes(2);
    } finally {
      duplicatePause.release.resolve(); newerPause.release.resolve();
    }
    if (!newer) throw new Error("Newer publication was not started");
    const [result] = await newer;
    expect(result.status).toBe("fulfilled");
    expect((await current(saved.slug)).skillText).toBe("# Newer accepted intent\n");
  });

  test("ready package provenance is never overwritten by a later provenance-only publication", async () => {
    const input = {
      personaSlug: f.org.slug, skill: "# Durable provenance\n", items: authored().items,
      manifest: { skill: "provenance-skill", name: "Provenance skill", description: "Keep evidence", situations: [{ id: "decide", name: "Decide" }] },
      changes: { summary: "Original evidence" },
    };
    const saved = await ingestTwinSkill(f.org.id, input);
    const version = await current(saved.slug);
    const snapshot = new Map(files); const writes = putObject.mock.calls.length;
    await ingestTwinSkill(f.org.id, { ...input, changes: { summary: "Must not replace ready evidence" } });
    expect((await registry(saved.slug)).versions).toHaveLength(1);
    expect((await current(saved.slug)).id).toBe(version.id);
    expect(files.get(`${saved.artifacts}/changes.json`)).toBe(JSON.stringify(input.changes, null, 1) + "\n");
    expect(files).toEqual(snapshot);
    expect(putObject).toHaveBeenCalledTimes(writes);
    expect(writeSkill).toHaveBeenCalledTimes(1);
  });

  test("a timed-out provider callback cannot overwrite retry-ready files, provenance or canonical index scope", async () => {
    const input = {
      personaSlug: f.org.slug, skill: "# Timed-out publication\n", items: authored().items,
      manifest: { skill: "timeout-skill", name: "Timeout skill", description: "Isolate physical attempts", situations: [{ id: "decide", name: "Decide" }] },
      changes: { summary: "Expired attempt evidence" },
    };
    const previous = await ingestTwinSkill(f.org.id, { ...input, skill: "# Previous ready package\n" });
    const previousVersion = await current(previous.slug);
    const entered = barrier(); const release = barrier(); const callbackFinished = barrier();
    let abandonedScope = ""; let shortened = false; let callbackError: unknown;
    let expiredTx: Prisma.TransactionClient | undefined; let callbackCompleted = false;
    const canonical = new Map<string, { packageId: string; items: Parameters<typeof MainCollectionService.writeSkillItems>[3] }>();
    const legacy = new Map<number, Parameters<typeof MainCollectionService.writeScenarioItems>[4]>();
    writeSkill.mockImplementation(async (_org, packageId, _scenario, items, indexScope) => {
      if (!indexScope) throw new Error("Canonical writes require a physical index scope");
      canonical.set(indexScope, { packageId, items: structuredClone(items) });
      return items.length;
    });
    writeScenario.mockImplementation(async (_org, _slug, _scenario, version, items) => {
      legacy.set(version, structuredClone(items)); return items.length;
    });
    const lock = database.withLock;
    lockSpies.push(spyOn(database, "withLock").mockImplementation((keys, work, options) => {
      expect(keys).toEqual([`skill-ownership:${f.org.id}`, `agent:${previous.slug}`]);
      if (!shortened && options?.timeout === 120_000) {
        shortened = true;
        return lock(keys, async (tx) => {
          expiredTx = tx;
          try {
            return await work(tx);
          } catch (error) {
            callbackError = error; throw error;
          } finally {
            callbackCompleted = true;
            callbackFinished.resolve();
          }
        }, { ...options, timeout: 100 });
      }
      return lock(keys, work, options);
    }));
    putObject.mockImplementationOnce(async (key, body) => {
      expect(key.endsWith("/SKILL.md")).toBe(true);
      abandonedScope = key.slice(0, -"/SKILL.md".length);
      entered.resolve();
      await release.promise;
      files.set(key, body);
    });
    const expired = Promise.allSettled([ingestTwinSkill(f.org.id, input)]);
    let winner: Awaited<ReturnType<typeof ingestTwinSkill>> | undefined;
    let winnerVersionId = "";
    let winningFiles = new Map<string, string>();
    let winningIndex: { packageId: string; items: Parameters<typeof MainCollectionService.writeSkillItems>[3] } | undefined;
    try {
      await entered.promise;
      await lock([`agent:${previous.slug}`], async () => undefined, { timeout: 1_000, maxWait: 1_000 });
      expect(shortened).toBe(true);
      expect(callbackCompleted).toBe(false);
      if (!expiredTx) throw new Error("Timed transaction was not captured");
      await expect(Promise.resolve(expiredTx.skill.findUniqueOrThrow({ where: { id: previousVersion.skillId } }))).rejects.toMatchObject({ code: "P2028" });
      const failedRegistry = await registry(previous.slug);
      const failed = failedRegistry.versions[0];
      expect(failedRegistry.currentVersionId).toBe(previousVersion.id);
      expect(failed).toMatchObject({ status: "pending", skillText: input.skill });
      expect(abandonedScope.startsWith(`${failed.artifacts}/attempt-`)).toBe(true);
      expect(failed.artifacts).not.toBe(abandonedScope);
      winner = await ingestTwinSkill(f.org.id, { ...input, changes: { summary: "Retry winning evidence" } });
      winnerVersionId = failed.id;
      expect(winner.artifacts).not.toBe(abandonedScope);
      expect(winner.artifacts.startsWith(`${failed.artifacts}/attempt-`)).toBe(true);
      expect(await current(previous.slug)).toMatchObject({ id: failed.id, version: failed.version, artifacts: winner.artifacts, status: "ready", indexStatus: "ready", failure: null });
      for (const [name, bytes] of Object.entries(skillFiles((await current(previous.slug)).files))) expect(files.get(`${winner.artifacts}/${name}`)).toBe(bytes);
      expect(files.get(`${winner.artifacts}/changes.json`)).toBe(JSON.stringify({ summary: "Retry winning evidence" }, null, 1) + "\n");
      winningFiles = new Map([...files].filter(([key]) => key.startsWith(`${winner.artifacts}/`)));
      winningIndex = canonical.get(winner.artifacts);
      expect(winningIndex).toEqual({ packageId: failed.id, items: input.items });
      expect(canonical.has(abandonedScope)).toBe(false);
      expect(legacy.get(winner.version)).toEqual(input.items);
    } finally {
      release.resolve();
      await callbackFinished.promise;
      await expired;
    }
    if (!winner) throw new Error("Retry winner was not published");
    const [outcome] = await expired;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      const error: unknown = outcome.reason;
      expect(error).toMatchObject({ code: "P2028" });
    }
    expect(callbackError).toMatchObject({ code: "P2028" });
    expect(files.get(`${abandonedScope}/SKILL.md`)).toBe(input.skill);
    expect(files.get(`${abandonedScope}/changes.json`)).toBe(JSON.stringify(input.changes, null, 1) + "\n");
    expect(canonical.get(abandonedScope)).toEqual({ packageId: winnerVersionId, items: input.items });
    expect(canonical.get(winner.artifacts)).toEqual(winningIndex);
    expect(new Map([...files].filter(([key]) => key.startsWith(`${winner.artifacts}/`)))).toEqual(winningFiles);
    expect(legacy.get(winner.version)).toEqual(input.items);
    expect(await current(previous.slug)).toMatchObject({ id: winnerVersionId, artifacts: winner.artifacts, status: "ready", indexStatus: "ready", failure: null });
    expect(await agent(previous.slug)).toMatchObject({ version: winner.version, data: { artifacts: winner.artifacts, skill: input.skill } });
  });

  test("automatic pruning stays disabled across failed reservations and successive compatibility publications", async () => {
    const original = await ingestScenario(f.org.id, authored());
    prune.mockClear();
    storageFailure = true;
    await expect(ingestScenario(f.org.id, authored("# Retry after a gap\n"))).rejects.toThrow("S3 publication failed");
    expect(prune).not.toHaveBeenCalled();
    expect((await agent(original.slug)).version).toBe(original.version);
    storageFailure = false;
    const saved = await ingestScenario(f.org.id, authored("# Retry after a gap\n"));
    expect(saved.version).toBeGreaterThan(original.version + 1);
    expect(prune).not.toHaveBeenCalled();
    expect(files.get(`${original.artifacts}/SKILL.md`)).toBe(authored().skill);
    const next = await ingestScenario(f.org.id, authored("# Another committed version\n"));
    expect(next.version).toBeGreaterThan(saved.version);
    expect(prune).not.toHaveBeenCalled();
  });

  test("database rejects cross-org primarySkill references including an unowned Agent", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    const skill = await registry(saved.slug);
    await expect(Promise.resolve(db.agent.update({ where: { id: other.roleplay.id }, data: { primarySkillId: skill.id } }))).rejects.toThrow();
    await expect(Promise.resolve(db.agent.update({ where: { id: f.roleplay.id }, data: { primarySkillId: skill.id, orgId: null } }))).rejects.toThrow();
    expect(await agent(other.roleplay.slug)).toMatchObject({ orgId: other.org.id, primarySkillId: null });
  });

  test.each([
    { skillText: "tampered" }, { files: { "SKILL.md": "tampered" } }, { manifest: { name: "tampered" } },
    { contentHash: "tampered" }, { artifacts: "tampered" }, { format: "twin" }, { itemCount: 99 },
    { id: "tampered" }, { version: 99 }, { status: "pending" }, { status: "failed" },
  ] satisfies Prisma.SkillVersionUpdateInput[])("database rejects ready package mutation %j", async (data) => {
    const saved = await ingestScenario(f.org.id, authored());
    const version = await current(saved.slug);
    await expect(Promise.resolve(db.skillVersion.update({ where: { id: version.id }, data }))).rejects.toThrow();
    expect(await current(saved.slug)).toEqual(version);
  });

  test("database rejects current pointers to pending, failed, or another skill's ready version", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    const skill = await registry(saved.slug);
    const version = await current(saved.slug);
    for (const status of ["pending", "failed"]) {
      const pending = await db.skillVersion.create({ data: {
        skillId: skill.id, version: status === "pending" ? 2 : 3, status, format: version.format,
        contentHash: `${version.contentHash}-${status}`, skillText: version.skillText,
        manifest: authored().scenario, files: skillFiles(version.files),
        artifacts: `${version.artifacts}-${status}`, itemCount: version.itemCount,
      } });
      await expect(Promise.resolve(db.skill.update({ where: { id: skill.id }, data: { currentVersionId: pending.id } }))).rejects.toThrow();
    }
    const otherSaved = await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    const foreignVersion = await current(otherSaved.slug);
    await expect(Promise.resolve(db.skill.update({ where: { id: skill.id }, data: { currentVersionId: foreignVersion.id } }))).rejects.toThrow();
    expect((await registry(saved.slug)).currentVersionId).toBe(version.id);
  });

  test("database protects ready ownership and referenced history while allowing operational index state changes", async () => {
    const saved = await ingestScenario(f.org.id, authored());
    const version = await current(saved.slug);
    const another = await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    const otherSkill = await registry(another.slug);
    await expect(Promise.resolve(db.skillVersion.update({ where: { id: version.id }, data: { skillId: otherSkill.id, version: 99 } }))).rejects.toThrow();
    await expect(Promise.resolve(db.skillVersion.delete({ where: { id: version.id } }))).rejects.toThrow();
    const operational = await db.skillVersion.update({ where: { id: version.id }, data: { indexStatus: "failed", failure: "Rebuild required" } });
    expect(operational).toMatchObject({ status: "ready", indexStatus: "failed", failure: "Rebuild required", files: version.files, contentHash: version.contentHash });
    expect((await registry(saved.slug)).currentVersionId).toBe(version.id);
  });
});
