/**
 * Ports an org's no-skill interview role plays (Vasanth's) into authored skill role plays, published next to them.
 * Dry run by default: prints the plan and every behavior difference. `--apply` publishes through the shared skill
 * publisher; rerunning is idempotent (an unchanged package is a no-op). Originals are never changed.
 *
 *   bun scripts/port-vasanth-skills.ts --org careerwithvasanth [--persona Vasanth] [--only slug,...] [--apply]
 *
 * Local only: refuses unless the database is a local `_local`/`_test` database, S3 is the local endpoint with fake
 * credentials, and Chroma is a local URL without cloud credentials.
 */
import { createHash } from "node:crypto";

export function assertLocalPortEnvironment(env: NodeJS.ProcessEnv) {
  const url = new URL(env.DATABASE_URL ?? "postgresql://invalid");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/_(local|test)$/.test(url.pathname.slice(1))) {
    throw new Error("Port requires a local *_local or *_test database");
  }
  if (env.DATABASE_URL_UNPOOLED && env.DATABASE_URL_UNPOOLED !== env.DATABASE_URL) throw new Error("DATABASE_URL_UNPOOLED must equal DATABASE_URL");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.AWS_ENDPOINT_URL_S3 ?? "") || env.AWS_ACCESS_KEY_ID !== "S3RVER" || env.AWS_SECRET_ACCESS_KEY !== "S3RVER") {
    throw new Error("Port requires local S3 with fake credentials");
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.CHROMA_URL ?? "") || env.CHROMA_API_KEY) {
    throw new Error("Port requires local Chroma without cloud credentials");
  }
}

function args(argv: string[]) {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
    ?? (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  return {
    org: value("org") ?? "careerwithvasanth",
    persona: value("persona"),
    only: value("only")?.split(",").map((slug) => slug.trim()).filter(Boolean),
    apply: argv.includes("--apply"),
  };
}

async function main() {
  assertLocalPortEnvironment(process.env);
  const options = args(process.argv.slice(2));
  const { db } = await import("../lib/db");
  const { interviewSkillPackage } = await import("../lib/interview-skill");
  const { publishInterviewSkill } = await import("../lib/scenario-ingest");
  const [database] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const org = await db.organization.findUniqueOrThrow({ where: { slug: options.org }, select: { id: true, slug: true } });
  const agents = await db.agent.findMany({
    where: { orgId: org.id, kind: "ROLEPLAY", archivedAt: null, primarySkillId: null, ...(options.only ? { slug: { in: options.only } } : {}) },
    select: { slug: true, name: true, version: true, data: true, persona: { select: { slug: true } } },
    orderBy: { slug: "asc" },
  });
  const sources = agents.filter((agent) => {
    const data = agent.data as Record<string, unknown> | null;
    return !(typeof data?.skill === "string" && data.skill) && !data?.portedFrom;
  });
  console.log(`database=${database.name} org=${org.slug} interviews=${sources.length} mode=${options.apply ? "apply" : "dry-run"}`);
  const report = [];
  for (const agent of sources) {
    const pkg = interviewSkillPackage(agent);
    const target = `${org.slug}-${pkg.scenario.scenario}`;
    const entry: Record<string, unknown> = {
      source: `${agent.slug}@v${agent.version}`, target, steps: pkg.scenario.steps.length, skillBytes: Buffer.byteLength(pkg.skill),
      skillSha256: createHash("sha256").update(pkg.skill).digest("hex").slice(0, 16), tools: pkg.settings.tools, upload: Boolean(pkg.settings.before), notes: pkg.notes,
    };
    if (options.apply) {
      const published = await publishInterviewSkill(org.id, {
        personaSlug: options.persona ?? agent.persona.slug, scenario: pkg.scenario, skill: pkg.skill, items: pkg.items, settings: pkg.settings,
      });
      const row = await db.agent.findUniqueOrThrow({ where: { slug: published.slug }, select: { primarySkillId: true, primarySkill: { select: { currentVersion: { select: { version: true, status: true, indexStatus: true, format: true } } } } } });
      Object.assign(entry, { version: published.version, created: published.created, package: row.primarySkill?.currentVersion });
    }
    report.push(entry);
  }
  console.log(JSON.stringify(report, null, 2));
  await db.$disconnect();
}

if (import.meta.main) await main();
