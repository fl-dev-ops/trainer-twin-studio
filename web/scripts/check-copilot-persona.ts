import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "../tests/setup/test-db-url";

// Run from web/ against a migrated local *_test DB, local S3 (as in e2e/env.ts) and local Chroma.
assert(testDatabaseUrl() && testDatabaseUrl() === process.env.DATABASE_URL, "Set DATABASE_URL to an isolated local *_test database");
process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;
Object.assign(process.env, {
  AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9100", AWS_ACCESS_KEY_ID: "S3RVER", AWS_SECRET_ACCESS_KEY: "S3RVER",
  AWS_REGION: "us-east-1", S3_BUCKET: "olga-local", S3_BASE_PREFIX: "copilot-qa",
  CHROMA_URL: process.env.COPILOT_QA_CHROMA_URL ?? "http://127.0.0.1:8000", CHROMA_API_KEY: "", CHROMA_TENANT: "default_tenant",
});
assert(["localhost", "127.0.0.1"].includes(new URL(process.env.CHROMA_URL!).hostname), "Use a local Chroma server");
const { db } = await import("@/lib/db");
const { ChromaTenantService } = await import("@/lib/chroma-tenant");
const { orgPrefix, putObject, deletePrefix } = await import("@/lib/s3");
const { POST } = await import("@/app/api/internal/copilot-studio/route");
const { GET } = await import("@/app/api/internal/knowledge-sources/route");
const org = `persona-qa-${crypto.randomUUID()}`;
const user = `${org}-trainer`;
const voice = `${org}-voice`;
const learner = `${org}-learner`;
const secret = crypto.randomUUID();
process.env.SCENARIO_INGEST_SECRET = secret;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/api/internal/copilot-studio" && req.method === "POST") return POST(req);
  if (path === "/api/internal/knowledge-sources" && req.method === "GET") return GET(req);
  return new Response(null, { status: 404 });
} });
const knowledgeKey = `${orgPrefix(org)}/demo-playbook.md`;
const phrase = `cedar-${crypto.randomUUID().slice(0, 8)}`;
try {
  await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: user, email: `${user}@example.com`, name: "QA Trainer", emailVerified: true } });
    await tx.organization.create({ data: { id: org, slug: org, name: "Persona QA", createdAt: new Date(), members: { create: { id: `${org}-member`, role: "admin", userId: user, createdAt: new Date() } } } });
    await tx.voice.create({ data: { id: voice, orgId: org, name: "Granite Demo", kind: "cloned", status: "ready", s3AudioKey: `fixture/${org}/tts-voices/${voice}/reference.wav` } });
    const persona = await tx.persona.create({ data: { orgId: org, slug: "qa-trainer", name: "QA Trainer", isOwn: true, data: {} } });
    await tx.user.create({ data: { id: learner, name: "Riley Example", email: `${learner}@example.com`, emailVerified: true } });
    const member = await tx.member.create({ data: { id: `${learner}-member`, role: "user", userId: learner, organizationId: org, createdAt: new Date() } });
    const twin = await tx.agent.create({ data: { orgId: org, personaId: persona.id, kind: "TWIN", slug: `${org}-twin-sample`, name: "Silver Compass", data: {} } });
    const roleplay = await tx.agent.create({ data: { orgId: org, personaId: persona.id, kind: "ROLEPLAY", slug: `${org}-practice-sample`, name: "Orchard Follow-up", data: {} } });
    const deployment = await tx.deployment.create({ data: { orgId: org, agentId: roleplay.id, publicKey: `${org}-practice-key` } });
    await tx.twinAssignment.create({ data: { orgId: org, userId: learner, agentId: twin.id, minutesLimit: 30, shareCode: `${org}-twin-code` } });
    await tx.rolePlayAssignment.create({ data: { orgId: org, memberId: member.id, assignedByUserId: user, deploymentId: deployment.id, shareCode: `${org}-practice-code`, expiresAt: new Date("2099-01-01") } });
    const kb = await tx.knowledgeBase.create({ data: { orgId: org, slug: "demo", name: "Demo" } });
    await tx.knowledgeDocument.create({ data: { kbId: kb.id, slug: "demo-playbook", title: "Demo Playbook", status: "indexed", ext: "md", size: 64, s3SourceKey: knowledgeKey, s3MarkdownKey: knowledgeKey } });
  });
  await putObject(knowledgeKey, `# Demo Playbook\nThe fallback phrase for an unconfirmed demo is ${phrase}.`, "text/markdown");
  const evalRun = Bun.spawn(["bunx", "eve", "eval", "persona-approval", "--skip-report"], {
    cwd: fileURLToPath(new URL("../../copilot", import.meta.url)), stdout: "inherit", stderr: "inherit",
    env: { ...process.env, STUDIO_URL: server.url.origin, COPILOT_SERVICE_SECRET: secret, SCENARIO_INGEST_SECRET: secret,
      PERSONA_QA_ORG: org, PERSONA_QA_USER: user, PERSONA_QA_VOICE: voice, PERSONA_QA_PHRASE: phrase, OTEL_SDK_DISABLED: "", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" },
  });
  assert.equal(await evalRun.exited, 0);
  const personas = await db.persona.findMany({ where: { orgId: org, isOwn: false }, select: { slug: true, voiceId: true, version: true, data: true } });
  assert.equal(personas.length, 1);
  assert.equal(personas[0].slug, "maya-approved");
  assert.equal(personas[0].voiceId, voice);
  assert.equal(personas[0].version, 2);
  assert.match(JSON.stringify(personas[0].data), /You ask one short question at a time/);
  const twin = await db.agent.findUniqueOrThrow({ where: { slug: `${org}-qa-trainer-twin` } });
  assert.equal(twin.kind, "TWIN");
  assert.equal(twin.name, "Compass Trainer Twin");
  assert.equal(twin.version, 2);
  const roleplay = await db.agent.findUniqueOrThrow({ where: { slug: `${org}-renewal-check-in` } });
  assert.equal(roleplay.kind, "ROLEPLAY");
  assert.equal(roleplay.name, "Renewal Check-in");
  assert.equal((roleplay.data as { before?: { preUpload?: boolean } }).before?.preUpload, true);
} finally {
  server.stop(true);
  if ((await db.organization.findUnique({ where: { id: org } }))?.chromaTenantId) await ChromaTenantService.deleteOrgDatabase(org);
  await deletePrefix(`${orgPrefix(org)}/`);
  await db.$transaction([
    db.agent.deleteMany({ where: { orgId: org } }),
    db.skillVersionSource.deleteMany({ where: { orgId: org } }),
    db.skill.updateMany({ where: { orgId: org }, data: { currentVersionId: null } }),
    db.skillVersion.deleteMany({ where: { skill: { orgId: org } } }),
    db.skill.deleteMany({ where: { orgId: org } }),
    db.specVersion.deleteMany({ where: { orgId: org } }),
    db.persona.deleteMany({ where: { orgId: org } }),
    db.voice.deleteMany({ where: { orgId: org } }),
    db.organization.deleteMany({ where: { id: org } }),
    db.user.deleteMany({ where: { id: { in: [user, learner] } } }),
  ]);
  await db.$disconnect();
}
