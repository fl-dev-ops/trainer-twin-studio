import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { SkillFormat } from "@/lib/skills";

const expectedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_live_test?host=/tmp";
const expectedPrefix = "trainertwin-shared-skills-live-20261119";
const approvedTemp = "/private/var/folders/5g/1ftb3rfd00n1966h7sf_lp5c0000gn/T/opencode";
const args = process.argv.slice(2);
const reportArg = args.find((arg) => arg.startsWith("--report="))?.slice("--report=".length);
assert(args.includes("--apply"), "Requires explicit --apply; creates retained synthetic fixtures and real provider resources.");
assert(args.every((arg) => arg === "--apply" || arg.startsWith("--report=")), "Unsupported argument");
assert(process.env.DATABASE_URL === expectedDatabase, "Refusing any other database URL");
const databaseUrl = new URL(expectedDatabase);
assert.equal(databaseUrl.hostname, "localhost");
assert.equal(databaseUrl.pathname, "/trainertwin_shared_skills_live_test");
assert.equal(process.env.S3_BASE_PREFIX, expectedPrefix, "Refusing any other S3 prefix");
const localChroma = process.env.CHROMA_URL === "http://127.0.0.1:8100";
assert(!process.env.CHROMA_URL || localChroma, "Only Chroma Cloud or the explicitly approved isolated local Chroma is allowed");
if (localChroma) {
  assert.equal(process.env.CHROMA_TENANT, "default_tenant");
  assert(!process.env.CHROMA_API_KEY, "Self-hosted canary must not send Cloud credentials");
}
const credentials = Object.fromEntries([
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CHROMA_TENANT", "COPILOT_SERVICE_SECRET",
].map((key) => [key, Boolean(process.env[key]?.trim())]));
assert(Object.values(credentials).every(Boolean), "Missing required provider credentials");
if (!localChroma) assert(process.env.CHROMA_API_KEY?.trim(), "Chroma Cloud requires credentials");
assert(process.env.S3_BUCKET || process.env.AWS_S3_BUCKET, "Missing S3 bucket");
assert(process.env.AI_GATEWAY_API_KEY || process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY, "Missing embeddings credentials");
const webUrl = new URL(process.env.SHARED_SKILLS_LIVE_WEB_URL ?? "http://localhost:3100");
assert.equal(webUrl.hostname, "localhost", "Only the parent's local web service is allowed");
assert.equal(webUrl.port, "3100");
assert.equal(webUrl.protocol, "http:");
const chatUrl = new URL(process.env.CHAT_URL ?? "http://localhost:2000");
assert(["localhost", "127.0.0.1"].includes(chatUrl.hostname), "Only a local chat service is allowed");

const runId = randomUUID();
const orgId = `sharedskills-live-${runId}`;
const wrongOrgId = `sharedskills-live-${randomUUID()}`;
const reportPath = resolve(reportArg ?? `${approvedTemp}/shared-skills-live-${runId}.json`);
assert(
  reportPath.startsWith(`${approvedTemp}/`) || reportPath.startsWith(`${resolve("bench/results")}/`),
  "Report must be in approved temp or ignored bench/results",
);
type Check = { name: string; status: "passed" | "failed"; durationMs: number; error?: string };
type Fixture = {
  label: string; sessionId: string; agentSlug: string; userId: string; shareCode: string;
  runtimeToken?: string; agentToken?: string; activation: string;
  runtimeAttributes?: Record<string, string | number | boolean | null>;
};
const report = {
  runId, orgId, startedAt: new Date().toISOString(), finishedAt: null as string | null,
  status: "running", credentialsPresent: credentials, checks: [] as Check[],
  chromaProvider: localChroma ? "real self-hosted isolated Chroma; NOT Chroma Cloud" : "Chroma Cloud",
  httpTimings: [] as { action: string; status: number; durationMs: number }[],
  fixtures: [] as Fixture[], packages: [] as { format: string; slug: string; versionId: string; artifacts: string }[],
  retainedResources: true, s3Prefix: `${expectedPrefix}/${orgId}`,
  chromaDatabase: "", sourceDocumentId: "", wrongOrgId: "",
  ownedOrganizations: [orgId, wrongOrgId],
  publicationAttempts: [] as { versionId: string; status: string; indexStatus: string; artifacts: string; format: string }[],
  providerDiagnostics: [] as { provider: string; name: string; message: string }[],
  limits: { maxPublications: 24, maxHttpRequests: 55, deadlineMs: 900_000 },
  counts: { publications: 0, httpRequests: 0 },
  limitations: [
    "Automated synthetic canary, not a voice attestation or production cutover approval.",
    "Twin sessions are valid schema fixtures from coherent getters/resolvers; voice/Meteroid activation is not exercised.",
    "Fixtures and exact owned provider resources are intentionally retained for parent chat/voice verification.",
    "No existing learner data, production activation, migrations, global provider cleanup, or voice calls.",
  ],
};
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|DATABASE_URL/.test(key) && value && value.length > 5)
  .map(([, value]) => value!);
function redact(text: string) {
  return secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
}
async function persist() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  await chmod(reportPath, 0o600);
}
await persist();
const deadline = setTimeout(() => {
  report.status = "deadline-exceeded";
  void persist().finally(() => process.exit(1));
}, report.limits.deadlineMs);

const { db } = await import("@/lib/db");
const { ingestScenario, ingestTwinSkill, saveRoleplay, fileText } = await import("@/lib/scenario-ingest");
const { getAgentConfigForAgent } = await import("@/lib/specs");
const { resolveSnapshotSkill } = await import("@/lib/session-skills");
const { resolveTwinCatalog, ensureTwin } = await import("@/lib/twins");
const { activateSession } = await import("@/lib/interview-sessions");
const { buildSessionContext } = await import("@/lib/session-context");
const { verifySkillEnvelope, skillPackageHash } = await import("@/lib/skills");
const { getObjectBytes, putObject } = await import("@/lib/s3");
const { MainCollectionService } = await import("@/lib/main-collection");
const { rebuildSkillIndex } = await import("@/lib/skill-index");
const { orgDatabaseName } = await import("@/lib/chroma-tenant");
const { AdminCloudClient } = await import("chromadb");
const { migrateSkills, checkSkillMigrationCoverage } = await import("@/lib/skill-migration");
const { activateSkillOwnership, skillOwnership } = await import("@/lib/skill-ownership");
const { builtFrom } = await import("@/lib/skill-sources");
report.chromaDatabase = orgDatabaseName(orgId);
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
async function check(name: string, work: () => Promise<void>) {
  const start = performance.now();
  try {
    await work();
    report.checks.push({ name, status: "passed", durationMs: Math.round(performance.now() - start) });
  } catch (error) {
    report.checks.push({
      name, status: "failed", durationMs: Math.round(performance.now() - start),
      error: redact(error instanceof Error ? error.stack ?? error.message : String(error)),
    });
  }
  await persist();
  console.info(`${report.checks.at(-1)!.status}: ${name}`);
}
async function http(input: Record<string, unknown>, organization = orgId) {
  assert(++report.counts.httpRequests <= report.limits.maxHttpRequests, "HTTP request budget exceeded");
  const started = performance.now();
  const response = await fetch(new URL("/api/copilot/studio", webUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.COPILOT_SERVICE_SECRET}`,
      "x-trainertwin-org-id": organization, "content-type": "application/json",
    },
    body: JSON.stringify(input), signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  report.httpTimings.push({ action: String(input.action), status: response.status, durationMs: Math.round(performance.now() - started) });
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { nonJsonResponse: text.slice(0, 300) }; }
  return { status: response.status, body };
}
function examples(body: unknown): { text: string; role: string }[] {
  assert(body && typeof body === "object" && "examples" in body && Array.isArray(body.examples), "Expected examples response");
  return body.examples.map((entry: unknown) => {
    assert(entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string" && "role" in entry && typeof entry.role === "string");
    return { text: entry.text, role: entry.role };
  });
}
const getContext = (fixture: Fixture) => http({ action: "getSessionContext", sessionId: fixture.sessionId, agentSlug: fixture.agentSlug });
const search = (fixture: Fixture, extra: Record<string, unknown> = {}, organization = orgId) => http({
  action: "searchScenarioItems", sessionId: fixture.sessionId, agentSlug: fixture.agentSlug,
  query: "What concern should I explore before advising?", limit: 3, ...extra,
}, organization);
const userId = `${orgId}-admin`;
const personaSlug = `${orgId}-persona`;
let personaId = "";
let documentId = "";
report.wrongOrgId = wrongOrgId;

async function seed() {
  assert.equal(await db.organization.count({ where: { id: { in: [orgId, wrongOrgId] } } }), 0);
  await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: `${userId}@example.invalid`, name: "Synthetic canary trainer", emailVerified: true } });
    for (const id of [orgId, wrongOrgId]) {
      await tx.organization.create({ data: {
        id, slug: id, name: "Shared skills synthetic live canary", createdAt: new Date(),
        members: { create: [{ id: `${id}-member`, userId, role: "admin", createdAt: new Date() }] },
      } });
    }
  });
  const persona = await db.persona.create({ data: {
    orgId, slug: personaSlug, name: "Synthetic Canary Trainer", isOwn: true,
    data: { identity: "Synthetic canary trainer, never a real learner.", role: "Buyer", style: "Ask concise questions before advising." },
  } });
  personaId = persona.id;
  const kb = await db.knowledgeBase.create({ data: { orgId, slug: `${orgId}-evidence`, name: "Synthetic canary evidence" } });
  const sourceKey = `${expectedPrefix}/${orgId}/canary/evidence.txt`;
  const text = "Synthetic evidence: ask what concern matters most before suggesting a next step.\n";
  await putObject(sourceKey, text, "text/plain");
  const document = await db.knowledgeDocument.create({ data: {
    kbId: kb.id, slug: "synthetic-evidence", title: "Synthetic canary original evidence",
    ext: "txt", size: Buffer.byteLength(text), s3SourceKey: sourceKey,
  } });
  documentId = document.id;
  report.sourceDocumentId = documentId;
  await persist();
}
async function publish(format: SkillFormat, revision: number, suffix = "", empty = false) {
  assert(++report.counts.publications <= report.limits.maxPublications, "Publication budget exceeded");
  const topic = `${format}${suffix}`;
  if (format === "builder-roleplay") {
    return saveRoleplay(orgId, {
      name: "Synthetic builder canary", persona: personaSlug,
      situation: { scenario: `Synthetic concern revision ${revision}`, learnerRole: "Advisor" },
      difficulty: "medium", opening: `Builder original revision ${revision}: what is the concern?`,
      exampleLines: [`Builder example revision ${revision}: explore before advising.`],
      guardedIf: [], opensUpIf: [], learnerGoals: [`Ask about concern revision ${revision}`],
      rubric: [{ name: "Understanding", points: 100 }],
    }, `${orgId}-builder-roleplay`);
  }
  const items = empty ? [] : [{
    id: `line-${revision}`, role: "trainer" as const, context: "Exploring a synthetic concern",
    text: `${topic} original revision ${revision}: ask what concern matters before advising.`,
    metadata: { step: "explore", move: "ask", source: documentId },
  }];
  const skill = `# ${topic}\r\n\r\nOriginal synthetic instructions revision ${revision}. Ask before advising.\r\n`;
  if (format === "twin") return ingestTwinSkill(orgId, {
    personaSlug, skill, patterns: "# Synthetic evidence\r\nExact bytes preserved.\r\n",
    manifest: { skill: topic, name: topic, description: `Synthetic topic revision ${revision}`, situations: [{ id: "explore", name: "Explore" }] },
    items,
  });
  return ingestScenario(orgId, {
    kind: format === "legacy-twin" ? "TWIN" : "ROLEPLAY", personaSlug, skill, items,
    patterns: "# Synthetic evidence\r\nExact bytes preserved.\r\n",
    scenario: {
      scenario: topic, name: topic, description: `Synthetic concern revision ${revision}`,
      trainer_role: "Buyer", learner_role: "Advisor",
      steps: [{ id: "explore", name: "Explore", trainer_moves: ["ask"], learner_moves: ["answer"] }],
    },
  });
}
async function twinFixture(slug: string, label: string): Promise<Fixture> {
  const row = await db.$transaction(async (tx) => {
    const config = await getAgentConfigForAgent(slug, orgId, undefined, [], tx);
    assert(config && config.agent.kind === "TWIN");
    const isMain = config.agent.data && typeof config.agent.data === "object" && !Array.isArray(config.agent.data) && config.agent.data.source === "twin";
    const selected = isMain ? await resolveTwinCatalog(orgId, config.persona.id, tx) : null;
    const version = selected ? null : await resolveSnapshotSkill(orgId, config.agent, "TWIN", tx);
    const pins = selected?.pins ?? [{ skillVersionId: version!.id, alias: slug, position: 0 }];
    return tx.interviewSession.create({ data: {
      orgId, userId, agentId: config.agent.id, agentSlug: slug, agentVersion: config.agent.version,
      personaSlug: config.persona.slug, personaVersion: config.persona.version,
      shareCode: randomUUID(), mode: "voice", status: "assigned", allowedSeconds: 600,
      compiledSnapshot: json({ ...config, ...(selected ? { twinSkills: selected.catalog } : {}) }),
      skillPinsVersion: 1, ...(pins.length ? { skillPins: { create: pins } } : {}),
    } });
  });
  const fixture: Fixture = {
    label, sessionId: row.id, agentSlug: slug, userId, shareCode: row.shareCode,
    activation: "schema-valid synthetic fixture; business voice/Meteroid activation NOT exercised",
    runtimeAttributes: {
      orgId, sessionId: row.id, agentSlug: row.agentSlug, agentVersion: row.agentVersion,
      personaSlug: row.personaSlug, personaVersion: row.personaVersion, userId: row.userId, mode: row.mode,
    },
  };
  report.fixtures.push(fixture);
  await persist();
  return fixture;
}
async function roleplayFixture(slug: string, label: string): Promise<Fixture> {
  const id = `${orgId}-${label}`;
  await db.user.create({ data: { id, name: "Synthetic canary roleplay trainer", email: `${id}@example.invalid`, emailVerified: true } });
  await db.member.create({ data: { id: `${id}-member`, organizationId: orgId, userId: id, role: "team", createdAt: new Date() } });
  const call = await activateSession({ orgId, userId: id, agentSlug: slug, mode: "chat", idempotencyKey: runId });
  assert(call);
  const row = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
  const fixture: Fixture = {
    label, sessionId: call.id, agentSlug: slug, userId: id, shareCode: row.shareCode,
    runtimeToken: call.runtimeToken, agentToken: call.agentToken, activation: "actual activateSession chat",
    runtimeAttributes: {
      orgId, sessionId: row.id, agentSlug: row.agentSlug, agentVersion: row.agentVersion,
      personaSlug: row.personaSlug, personaVersion: row.personaVersion, userId: row.userId, mode: row.mode,
    },
  };
  report.fixtures.push(fixture);
  await persist();
  return fixture;
}
const pinned = (fixture: Fixture) => db.interviewSession.findUniqueOrThrow({
  where: { id: fixture.sessionId }, include: { skillPins: { include: { version: true }, orderBy: { position: "asc" } } },
});
async function fileHashes(versionId: string) {
  const version = await db.skillVersion.findFirstOrThrow({ where: { id: versionId, skill: { orgId } } });
  assert(version.artifacts.startsWith(`${expectedPrefix}/${orgId}/`));
  const files = verifySkillEnvelope(version);
  const entries = await Promise.all(Object.entries(files).map(async ([name, original]) => {
    const stored = await getObjectBytes(`${version.artifacts}/${name}`);
    assert.equal(hash(stored), hash(Buffer.from(original)), `Original S3 bytes differ: ${name}`);
    return [name, hash(stored)] as const;
  }));
  return Object.fromEntries(entries);
}

try {
  await seed();
  await check("service authentication rejects missing auth", async () => {
    const response = await fetch(new URL("/api/copilot/studio", webUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "getSessionContext", sessionId: "synthetic-invalid" }), signal: AbortSignal.timeout(30_000),
    });
    assert([401, 403].includes(response.status));
  });
  await check(`${localChroma ? "Self-hosted Chroma" : "Chroma Cloud"} isolated database provisioning preflight`, async () => {
    const { ChromaTenantService } = await import("@/lib/chroma-tenant");
    try {
      await ChromaTenantService.createOrgDatabase(orgId);
    } catch (error) {
      if (localChroma) throw error;
      // The application retries getDatabase after every create error, hiding quota errors behind a 404.
      try {
        await new AdminCloudClient({ apiKey: process.env.CHROMA_API_KEY }).createDatabase({
          name: orgDatabaseName(orgId), tenant: process.env.CHROMA_TENANT!,
        });
      } catch (providerError) {
        report.providerDiagnostics.push({
          provider: "Chroma Cloud", name: providerError instanceof Error ? providerError.name : "Unknown",
          message: redact(providerError instanceof Error ? providerError.message : String(providerError)),
        });
      }
      throw error;
    }
  });
  assert(report.checks.at(-1)?.status === "passed", "Live checks blocked by isolated Chroma provisioning; no shared provider database may be used as a fallback");
  const formatFixtures = new Map<SkillFormat, Fixture>();
  for (const format of ["builder-roleplay", "authored-roleplay", "twin", "legacy-twin"] as const) {
    await check(`${format}: publish v1/v2/v3, stable no-op, pinned cached context/search, S3 preservation`, async () => {
      const first = await publish(format, 1);
      const agent = await db.agent.findUniqueOrThrow({ where: { slug: first.slug } });
      const original = await db.agentSkillVersion.findUniqueOrThrow({
        where: { agentId_agentVersion: { agentId: agent.id, agentVersion: agent.version } }, include: { version: true },
      });
      assert.equal(original.version.format, format);
      assert.equal(original.version.version, 1);
      assert.equal(original.version.indexStatus, "ready");
      report.packages.push({ format, slug: first.slug, versionId: original.skillVersionId, artifacts: original.version.artifacts });
      const hashes = await fileHashes(original.skillVersionId);
      const noOp = await publish(format, 1);
      assert.equal(noOp.version, first.version);
      assert.equal(noOp.artifacts, first.artifacts);
      assert.deepEqual(await db.agent.findUniqueOrThrow({ where: { id: agent.id } }), agent);
      const fixture = format.includes("roleplay") ? await roleplayFixture(first.slug, format) : await twinFixture(first.slug, format);
      formatFixtures.set(format, fixture);
      const before = await pinned(fixture);
      assert.equal(before.skillPins.length, 1);
      assert.equal(before.skillPins[0].skillVersionId, original.skillVersionId);
      const direct = await buildSessionContext({ orgId, sessionId: fixture.sessionId, agentSlug: fixture.agentSlug });
      const context = await getContext(fixture);
      assert.equal(context.status, 200, JSON.stringify(context.body));
      assert.deepEqual(context.body, JSON.parse(JSON.stringify(direct)));
      for (const revision of [2, 3]) {
        await publish(format, revision);
        assert.deepEqual(await getContext(fixture), context);
      }
      assert.equal(await db.skillVersion.count({ where: { skillId: original.version.skillId } }), 3);
      const result = await search(fixture, { step: "nonexistent-step" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const hits = examples(result.body);
      assert(hits.length > 0);
      assert(hits.every((item) => item.text.includes("revision 1") && !item.text.includes("revision 3")));
      assert(hits.every((item) => item.role === (format === "builder-roleplay" ? "client" : "trainer")));
      assert.deepEqual((await pinned(fixture)).skillPins, before.skillPins);
      assert.deepEqual(await fileHashes(original.skillVersionId), hashes);
      const wrong = await search(fixture, {}, wrongOrgId);
      assert([403, 404].includes(wrong.status), `Wrong-org lookup returned ${wrong.status}`);
    });
  }
  await check("zero-item package returns an honest empty result", async () => {
    const saved = await publish("twin", 1, "-empty", true);
    const fixture = await twinFixture(saved.slug, "zero-items");
    assert.equal((await pinned(fixture)).skillPins[0].version.itemCount, 0);
    const result = await search(fixture);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(examples(result.body), []);
  });
  await check("main twin mixed managed/legacy catalog and frozen empty catalog", async () => {
    const legacyManifest = {
      scenario: "unmanaged-legacy", name: "Synthetic legacy", description: "Synthetic mixed catalog",
      trainer_role: "Trainer", learner_role: "Learner",
      steps: [{ id: "explore", name: "Explore", trainer_moves: ["ask"], learner_moves: ["answer"] }],
    };
    const legacyItems = [{
      id: "legacy-one", role: "trainer" as const, context: "Concern",
      text: "Unmanaged synthetic legacy original revision 1: ask about the concern.", metadata: { step: "explore" },
    }];
    const legacyFiles = {
      "SKILL.md": "# Synthetic unmapped legacy\nAsk about the concern.\n",
      "scenario.json": fileText.scenario(legacyManifest), "items.json": fileText.items(legacyItems),
      "patterns.md": "# Synthetic legacy evidence\n",
    };
    const legacyArtifacts = `${expectedPrefix}/${orgId}/canary/unmanaged-legacy/v1`;
    await Promise.all(Object.entries(legacyFiles).map(([name, bytes]) => putObject(`${legacyArtifacts}/${name}`, bytes, name.endsWith(".json") ? "application/json" : "text/markdown")));
    const historical = await db.agent.create({ data: {
      orgId, personaId, slug: `${orgId}-unmanaged-legacy`, name: "Synthetic unmapped legacy", kind: "TWIN", version: 1, order: 20,
      data: { source: "scenario-ingest", skill: legacyFiles["SKILL.md"], scenario: legacyManifest,
        artifacts: legacyArtifacts, filesHash: skillPackageHash("legacy-twin", legacyFiles) },
    } });
    await MainCollectionService.writeScenarioItems(orgId, historical.slug, "unmanaged-legacy", 1, legacyItems);
    const main = await ensureTwin(orgId, personaSlug);
    const fixture = await twinFixture(main.slug, "main-mixed");
    const context = await getContext(fixture);
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert(context.body && typeof context.body === "object" && "twinPlaybooks" in context.body && Array.isArray(context.body.twinPlaybooks));
    assert(context.body.twinPlaybooks.some((entry: { slug: string }) => entry.slug === historical.slug));
    assert.equal((await pinned(fixture)).skillPins.length, 3);
    const result = await search(fixture);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert(examples(result.body).length > 0);
    const alias = await search(fixture, { agentSlug: historical.slug });
    assert.equal(alias.status, 200, JSON.stringify(alias.body));
    assert(examples(alias.body).length > 0);
    assert(examples(alias.body).every((item) => item.text.includes("Unmanaged synthetic legacy")));
    const invalid = await search(fixture, { agentSlug: `${orgId}-not-in-catalog` });
    assert([403, 404].includes(invalid.status));
    const emptyPersona = await db.persona.create({ data: {
      orgId, slug: `${orgId}-empty-persona`, name: "Synthetic empty trainer", isOwn: true, data: {},
    } });
    const emptyMain = await ensureTwin(orgId, emptyPersona.slug);
    const empty = await twinFixture(emptyMain.slug, "main-empty");
    const emptyBefore = await getContext(empty);
    assert.equal(emptyBefore.status, 200);
    const emptySearch = await search(empty);
    assert.equal(emptySearch.status, 200);
    assert.deepEqual(examples(emptySearch.body), []);
    await ingestTwinSkill(orgId, {
      personaSlug: emptyPersona.slug, skill: "# Published after empty session\n",
      manifest: { skill: "later", name: "Later", description: "Synthetic later package", situations: [{ id: "explore", name: "Explore" }] }, items: [],
    });
    assert.deepEqual(await getContext(empty), emptyBefore);
    assert.deepEqual(examples((await search(empty)).body), []);
    assert.deepEqual(await getContext(fixture), context);
  });
  await check("missing exact owned real index refuses, rebuild restores original pin", async () => {
    const fixture = formatFixtures.get("twin");
    assert(fixture, "Missing v1 twin fixture");
    const pin = (await pinned(fixture)).skillPins[0];
    assert(pin.version.artifacts.startsWith(`${expectedPrefix}/${orgId}/`));
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
    assert.equal(org.chromaDatabase, orgDatabaseName(orgId));
    const count = await MainCollectionService.skillItemCount(orgId, pin.skillVersionId, pin.version.artifacts);
    assert.equal(count, pin.version.itemCount);
    assert(count > 0);
    const collection = await MainCollectionService.getCollection(orgId);
    await collection.delete({ where: { $and: [
      { type: "scenario_item" }, { orgId }, { skillVersionId: pin.skillVersionId }, { skillIndexScope: pin.version.artifacts },
    ] } });
    assert.equal(await MainCollectionService.skillItemCount(orgId, pin.skillVersionId, pin.version.artifacts), 0);
    const missing = await search(fixture);
    assert.equal(missing.status, 503, JSON.stringify(missing.body));
    const recovered = await rebuildSkillIndex(orgId, pin.skillVersionId);
    assert.equal(recovered.items, pin.version.itemCount);
    const result = await search(fixture);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert(examples(result.body).length > 0);
    assert(examples(result.body).every((item) => item.text.includes("revision 1")));
    await fileHashes(pin.skillVersionId);
  });
  await check("archive preserves pinned context/search while refusing new activation", async () => {
    const fixture = formatFixtures.get("authored-roleplay");
    assert(fixture);
    const before = await getContext(fixture);
    await db.agent.update({ where: { slug: fixture.agentSlug }, data: { archivedAt: new Date() } });
    assert.deepEqual(await getContext(fixture), before);
    assert.equal((await search(fixture)).status, 200);
    await assert.rejects(
      activateSession({ orgId, userId: fixture.userId, agentSlug: fixture.agentSlug, mode: "chat", idempotencyKey: randomUUID() }),
      (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 404),
    );
  });
  await check("verified history check/import idempotence and immutable source provenance", async () => {
    const fixture = formatFixtures.get("twin");
    assert(fixture);
    const pin = (await pinned(fixture)).skillPins[0];
    const agent = await db.agent.findUniqueOrThrow({ where: { slug: fixture.agentSlug } });
    const sources = await builtFrom(orgId, [{ agentId: agent.id, version: 1 }]);
    assert(sources?.some((source) => source.documentId === documentId && source.items === 1 && source.exists));
    const before = await pinned(fixture);
    const first = await migrateSkills(orgId, { apply: true });
    const second = await migrateSkills(orgId, { check: true });
    assert(first.complete && second.complete);
    for (const inventory of [first, second]) {
      assert.deepEqual(inventory.currentGaps, []);
      assert.deepEqual(inventory.requiredGaps, []);
      assert.deepEqual(inventory.historicalGaps, []);
    }
    const versions = await db.skillVersion.findMany({ where: { skill: { orgId } }, orderBy: { id: "asc" } });
    const repeated = await migrateSkills(orgId, { apply: true });
    assert(repeated.complete && repeated.entries.every((entry) => entry.status === "imported"));
    assert.deepEqual(await db.skillVersion.findMany({ where: { skill: { orgId } }, orderBy: { id: "asc" } }), versions);
    assert.deepEqual(await pinned(fixture), before);
    assert.equal((await db.skillVersion.findUniqueOrThrow({ where: { id: pin.skillVersionId } })).contentHash, pin.version.contentHash);
    assert(second.entries.filter((entry) => entry.slug === fixture.agentSlug).every((entry) => entry.status === "verified"));
    assert.equal((await db.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } })).title, "Synthetic canary original evidence");
    const ownedSources = await db.skillVersionSource.count({ where: { orgId, documentId } });
    assert(ownedSources >= 9);
  });
  await check("ownership explicit approval/stale inventory gates and synthetic-only managed publication", async () => {
    await assert.rejects(activateSkillOwnership(orgId, { apply: false, inventoryHash: "synthetic", canaryReference: "synthetic-not-voice" }));
    assert.equal((await skillOwnership(orgId)).mode, "compatibility");
    await assert.rejects(activateSkillOwnership(orgId, { apply: true, inventoryHash: "stale-synthetic", canaryReference: "automated-synthetic-not-voice" }));
    // Keep the synthetic ownership switch separate from the retained mixed-catalog fixtures.
    const gatedOrg = `sharedskills-live-${randomUUID()}`;
    report.ownedOrganizations.push(gatedOrg);
    await persist();
    await db.organization.create({ data: {
      id: gatedOrg, slug: gatedOrg, name: "Synthetic ownership gate only", createdAt: new Date(),
      members: { create: [{ id: `${gatedOrg}-member`, userId, role: "admin", createdAt: new Date() }] },
    } });
    const gatedPersona = await db.persona.create({ data: {
      orgId: gatedOrg, slug: `${gatedOrg}-persona`, name: "Synthetic gate trainer", isOwn: true, data: {},
    } });
    const inventory = await checkSkillMigrationCoverage(gatedOrg);
    assert(inventory.complete);
    const mode = await activateSkillOwnership(gatedOrg, {
      apply: true, inventoryHash: inventory.hash,
      canaryReference: `automated-synthetic-only-not-voice-not-production:${runId}`,
    });
    assert.equal(mode.mode, "managed");
    const saved = await ingestTwinSkill(gatedOrg, {
      personaSlug: gatedPersona.slug, skill: "# Synthetic managed-only package\r\n",
      manifest: { skill: "managed", name: "Synthetic managed", description: "Automated canary, not voice attestation", situations: [{ id: "explore", name: "Explore" }] },
      items: [{ id: "managed-one", role: "trainer", context: "Synthetic concern", text: "Synthetic managed example: ask first.", metadata: { step: "explore" } }],
    });
    const agent = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug } });
    assert(agent.data && typeof agent.data === "object" && !Array.isArray(agent.data));
    for (const field of ["skill", "scenario", "artifacts", "filesHash"]) assert(!(field in agent.data));
    const mapping = await db.agentSkillVersion.findUniqueOrThrow({ where: { agentId_agentVersion: { agentId: agent.id, agentVersion: agent.version } } });
    assert.equal(await MainCollectionService.skillItemCount(gatedOrg, mapping.skillVersionId, saved.artifacts), 1);
    report.packages.push({ format: "managed-only-twin", slug: saved.slug, versionId: mapping.skillVersionId, artifacts: saved.artifacts });
  });
  report.status = report.checks.some((entry) => entry.status === "failed") ? "failed" : "passed";
} catch (error) {
  report.status = "failed";
  report.checks.push({ name: "startup-or-seed", status: "failed", durationMs: 0, error: redact(error instanceof Error ? error.stack ?? error.message : String(error)) });
} finally {
  clearTimeout(deadline);
  report.publicationAttempts = (await db.skillVersion.findMany({
    where: { skill: { orgId: { in: report.ownedOrganizations } } },
    select: { id: true, status: true, indexStatus: true, artifacts: true, format: true },
  })).map(({ id, ...version }) => ({ versionId: id, ...version }));
  report.finishedAt = new Date().toISOString();
  await persist();
  await db.$disconnect();
}
console.info(JSON.stringify({ status: report.status, passed: report.checks.filter((entry) => entry.status === "passed").length, failed: report.checks.filter((entry) => entry.status === "failed").length, reportPath }));
process.exitCode = report.status === "passed" ? 0 : 1;
