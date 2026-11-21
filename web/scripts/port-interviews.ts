/**
 * Converts an org's legacy interview role plays (no skill; stages + config) into skill role plays IN PLACE: same agent
 * row and slug, so learner assignments, /s/<code> links and past sessions stay attached (plans/agents-to-roleplay.md).
 * The question bank is copied into the role play's items, stage evidence becomes the report rubric, and the résumé,
 * tools, knowledge search, voice and intro video are carried over. The old agent data is snapshotted as a SpecVersion
 * by the publish, which --rollback restores.
 *
 *   bun scripts/port-interviews.ts --org <slug> [--only slug,...]            dry run: the plan per interview
 *   bun scripts/port-interviews.ts --org <slug> [--only ...] --apply         convert
 *   bun scripts/port-interviews.ts --org <slug> --only <slug> --rollback     restore the legacy interview
 *
 * A non-local database also needs --confirm <database name>.
 */
import { createHash } from "node:crypto";

function args(argv: string[]) {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
    ?? (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  return {
    org: value("org"),
    only: value("only")?.split(",").map((slug) => slug.trim()).filter(Boolean),
    apply: argv.includes("--apply"),
    rollback: argv.includes("--rollback"),
    confirm: value("confirm"),
  };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())) : []);

/** Knowledge bases an interview searched: its list, its single KB, else the shared one the legacy runtime used. */
export function interviewKnowledgeBases(data: unknown): string[] {
  const d = asRecord(data);
  const listed = (Array.isArray(d.knowledge_bases) ? d.knowledge_bases : [])
    .map((kb) => (typeof kb === "string" ? kb : (asRecord(kb).slug ?? asRecord(kb).id)) as unknown)
    .filter((kb): kb is string => typeof kb === "string" && Boolean(kb));
  const single = typeof d.knowledgeBase === "string" && d.knowledgeBase ? [d.knowledgeBase] : [];
  return [...new Set([...listed, ...single])];
}

async function main() {
  const options = args(process.argv.slice(2));
  if (!options.org) throw new Error("--org <slug> is required");
  if (options.apply && options.rollback) throw new Error("--apply and --rollback are exclusive");
  const { db } = await import("../lib/db");
  const [database] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const host = new URL(process.env.DATABASE_URL ?? "postgresql://invalid").hostname;
  const local = ["localhost", "127.0.0.1", ""].includes(host);
  if ((options.apply || options.rollback) && !local && options.confirm !== database.name) {
    throw new Error(`Database "${database.name}" on ${host} is not local: add --confirm ${database.name}`);
  }
  const org = await db.organization.findUniqueOrThrow({ where: { slug: options.org }, select: { id: true, slug: true } });

  if (options.rollback) {
    if (!options.only?.length) throw new Error("--rollback needs --only <slug,...>");
    for (const slug of options.only) {
      const agent = await db.agent.findFirstOrThrow({ where: { orgId: org.id, slug }, select: { id: true, version: true, data: true } });
      const from = asRecord(asRecord(agent.data).portedFrom);
      if (typeof from.version !== "number") throw new Error(`${slug} was not converted by this script`);
      const snapshot = await db.specVersion.findFirstOrThrow({ where: { orgId: org.id, entityType: "agents", entitySlug: slug, version: from.version } });
      await db.$transaction([
        db.specVersion.create({ data: { orgId: org.id, entityType: "agents", entitySlug: slug, version: agent.version, data: agent.data as object } }),
        db.agent.update({ where: { id: agent.id }, data: { data: snapshot.data as object, primarySkillId: null, version: agent.version + 1 } }),
      ]);
      console.log(`rolled back ${slug} to its legacy interview (v${from.version} data, now v${agent.version + 1})`);
    }
    await db.$disconnect();
    return;
  }

  const { interviewSkillPackage } = await import("../lib/interview-skill");
  const { QuestionBank } = await import("../lib/question-bank");
  const { publishInterviewSkill } = await import("../lib/scenario-ingest");
  const agents = await db.agent.findMany({
    where: { orgId: org.id, kind: "ROLEPLAY", archivedAt: null, primarySkillId: null, ...(options.only ? { slug: { in: options.only } } : {}) },
    select: { slug: true, name: true, version: true, data: true, persona: { select: { slug: true } } },
    orderBy: { slug: "asc" },
  });
  const sources = agents.filter((agent) => {
    const data = asRecord(agent.data);
    return !(typeof data.skill === "string" && data.skill) && Array.isArray(data.stages);
  });
  console.log(`database=${database.name} org=${org.slug} interviews=${sources.length} mode=${options.apply ? "apply" : "dry-run"}`);
  const report = [];
  for (const agent of sources) {
    const interview = asRecord(asRecord(asRecord(agent.data).config).interview);
    const types = Object.entries(asRecord(interview.question_counts)).filter(([, n]) => typeof n === "number" && n > 0).map(([kind]) => kind);
    const topics = strings(interview.topic_slugs);
    const kbs = interviewKnowledgeBases(agent.data);
    const records = interview.type === "technical" && types.length
      ? await QuestionBank.listQuestions(org.id, kbs.length ? kbs : ["acme-knowledge"], { types, topics })
      : [];
    const questions = records.map((q) => ({
      id: q.id, text: q.text, spokenText: q.spokenText, questionType: q.questionType, difficulty: q.difficulty, topicSlugs: q.topicSlugs,
      code: q.code, options: q.options, keyPoints: q.evaluation.keyPoints,
    }));
    const pkg = interviewSkillPackage(agent, { questions });
    const entry: Record<string, unknown> = {
      slug: agent.slug, from: `v${agent.version}`, steps: pkg.scenario.steps.length, questions: pkg.items.length,
      rubric: pkg.settings.after.rubric.length, tools: pkg.settings.tools, before: pkg.settings.before ?? null,
      skillSha256: createHash("sha256").update(pkg.skill).digest("hex").slice(0, 16), notes: pkg.notes,
    };
    if (options.apply) {
      const published = await publishInterviewSkill(org.id, {
        personaSlug: agent.persona.slug, scenario: pkg.scenario, skill: pkg.skill, items: pkg.items, settings: pkg.settings, slug: agent.slug,
      });
      Object.assign(entry, { version: published.version, created: published.created });
    }
    report.push(entry);
  }
  console.log(JSON.stringify(report, null, 2));
  await db.$disconnect();
}

if (import.meta.main) await main();
