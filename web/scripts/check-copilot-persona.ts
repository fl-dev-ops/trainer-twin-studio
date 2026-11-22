import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "../tests/setup/test-db-url";

// Run from web/ against a migrated local test DB. Uses the live Copilot model and the real studio route.
assert(testDatabaseUrl() && testDatabaseUrl() === process.env.DATABASE_URL, "Set DATABASE_URL to an isolated local *_test database");
const { db } = await import("@/lib/db");
const { POST } = await import("@/app/api/internal/copilot-studio/route");
const org = `persona-qa-${crypto.randomUUID()}`;
const user = `${org}-trainer`;
const voice = `${org}-voice`;
const secret = crypto.randomUUID();
process.env.SCENARIO_INGEST_SECRET = secret;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) =>
  new URL(req.url).pathname === "/api/internal/copilot-studio" && req.method === "POST"
    ? POST(req) : new Response(null, { status: 404 }),
});
try {
  await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: user, email: `${user}@example.com`, name: "QA Trainer", emailVerified: true } });
    await tx.organization.create({ data: { id: org, slug: org, name: "Persona QA", createdAt: new Date(), members: { create: { id: `${org}-member`, role: "admin", userId: user, createdAt: new Date() } } } });
    await tx.voice.create({ data: { id: voice, orgId: org, name: "Granite Demo", kind: "cloned", status: "ready", s3AudioKey: `fixture/${org}/tts-voices/${voice}/reference.wav` } });
    await tx.persona.create({ data: { orgId: org, slug: "qa-trainer", name: "QA Trainer", isOwn: true, data: {} } });
  });
  const evalRun = Bun.spawn(["bunx", "eve", "eval", "persona-approval", "--skip-report"], {
    cwd: fileURLToPath(new URL("../../copilot", import.meta.url)), stdout: "inherit", stderr: "inherit",
    env: { ...process.env, STUDIO_URL: server.url.origin, COPILOT_SERVICE_SECRET: secret, SCENARIO_INGEST_SECRET: secret,
      PERSONA_QA_ORG: org, PERSONA_QA_USER: user, PERSONA_QA_VOICE: voice, OTEL_SDK_DISABLED: "", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" },
  });
  assert.equal(await evalRun.exited, 0);
  const personas = await db.persona.findMany({ where: { orgId: org, isOwn: false }, select: { slug: true, voiceId: true, version: true, data: true } });
  assert.equal(personas.length, 1);
  assert.equal(personas[0].slug, "maya-approved");
  assert.equal(personas[0].voiceId, voice);
  assert.equal(personas[0].version, 2);
  assert.match(JSON.stringify(personas[0].data), /You ask one short question at a time/);
  assert.equal(await db.agent.count({ where: { orgId: org, kind: "TWIN", slug: `${org}-qa-trainer-twin` } }), 1);
} finally {
  server.stop(true);
  await db.agent.deleteMany({ where: { orgId: org } });
  await db.specVersion.deleteMany({ where: { orgId: org } });
  await db.persona.deleteMany({ where: { orgId: org } });
  await db.voice.deleteMany({ where: { orgId: org } });
  await db.organization.deleteMany({ where: { id: org } });
  await db.user.deleteMany({ where: { id: user } });
  await db.$disconnect();
}
