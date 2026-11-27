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
 *   bun scripts/port-interviews.ts --org <slug> [--only ...] --reissue [--apply]
 *       re-render already-converted interviews from their legacy snapshot with the current interview-skill.ts and
 *       publish the new stage (settings the trainer changed since are kept), then write the interviewer character for
 *       the main persona where it is still the port placeholder (--force-character overwrites an edited one).
 *       --character <file> writes that trainer's character template instead of the generic one
 *       (e.g. data/roleplay/characters/vasanth-interviewer.md; {{interview}} and {{objective}} are filled in).
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
    reissue: argv.includes("--reissue"),
    forceCharacter: argv.includes("--force-character"),
    characterFile: value("character"),
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
  if (options.reissue && options.rollback) throw new Error("--reissue and --rollback are exclusive");
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

  if (options.reissue) {
    await reissue(org, options);
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
      code: q.code, options: q.options, correctOptionId: q.evaluation.correctOptionId, keyPoints: q.evaluation.keyPoints,
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

/** The migration's stand-in character (roleplay_character_port): safe to replace; anything else was edited. */
export const isPlaceholderCharacter = (character: string | null | undefined) =>
  !character?.trim() || /^## Who you are here\s+You play the .+ on this call\. The published skill describes who you are/.test(character.trim());

/** Agent.data keys the publisher derives from the package (lib/scenario-ingest.ts buildScenario); the rest are settings. */
const PACKAGE_DERIVED = new Set(["id", "name", "objective", "stages", "config", "skill", "source", "scenario", "artifacts", "filesHash"]);

/** Which Tools switches each question flow in the stage needs. */
function missingSwitches(skill: string, tools: Record<string, unknown>): string[] {
  const needs: [RegExp, string][] = [[/open_choice/, "choice"], [/open_code_editor/, "codeEditor"], [/open_whiteboard/, "canvas"], [/open_pdf|highlight_document/, "preview"]];
  return needs.filter(([pattern, key]) => pattern.test(skill) && tools[key] !== true).map(([, key]) => key);
}

async function reissue(org: { id: string; slug: string }, options: ReturnType<typeof args>) {
  const { db } = await import("../lib/db");
  const { interviewSkillPackage, interviewCharacter } = await import("../lib/interview-skill");
  const { QuestionBank } = await import("../lib/question-bank");
  const { publishInterviewSkill } = await import("../lib/scenario-ingest");
  const agents = await db.agent.findMany({
    where: { orgId: org.id, kind: "ROLEPLAY", archivedAt: null, primarySkillId: { not: null }, ...(options.only ? { slug: { in: options.only } } : {}) },
    select: { id: true, slug: true, name: true, version: true, data: true, persona: { select: { id: true, slug: true, name: true } } },
    orderBy: { slug: "asc" },
  });
  const ported = agents.filter((agent) => typeof asRecord(asRecord(agent.data).portedFrom).version === "number");
  const template = options.characterFile ? await Bun.file(options.characterFile).text() : undefined;
  console.log(`org=${org.slug} ported=${ported.length} mode=${options.apply ? "apply" : "dry-run"} (reissue)`);
  const report = [];
  for (const agent of ported) {
    const from = asRecord(asRecord(agent.data).portedFrom);
    const snapshot = await db.specVersion.findFirst({ where: { orgId: org.id, entityType: "agents", entitySlug: agent.slug, version: from.version as number } });
    if (!snapshot) { report.push({ slug: agent.slug, skipped: `no legacy snapshot v${from.version}` }); continue; }
    const legacy = { slug: agent.slug, name: agent.name, version: from.version as number, data: snapshot.data };
    const interview = asRecord(asRecord(asRecord(snapshot.data).config).interview);
    const types = Object.entries(asRecord(interview.question_counts)).filter(([, n]) => typeof n === "number" && n > 0).map(([kind]) => kind);
    const kbs = interviewKnowledgeBases(snapshot.data);
    const records = interview.type === "technical" && types.length
      ? await QuestionBank.listQuestions(org.id, kbs.length ? kbs : ["acme-knowledge"], { types, topics: strings(interview.topic_slugs) })
      : [];
    const pkg = interviewSkillPackage(legacy, { questions: records.map((q) => ({
      id: q.id, text: q.text, spokenText: q.spokenText, questionType: q.questionType, difficulty: q.difficulty, topicSlugs: q.topicSlugs,
      code: q.code, options: q.options, correctOptionId: q.evaluation.correctOptionId, keyPoints: q.evaluation.keyPoints,
    })) });
    const current = asRecord(agent.data);
    const row = await db.agentPersona.findFirst({ where: { agentId: agent.id, personaId: agent.persona.id }, select: { character: true } });
    const writeCharacter = options.forceCharacter || isPlaceholderCharacter(row?.character);
    const character = interviewCharacter({ personaName: agent.persona.name, interviewName: agent.name, objective: pkg.scenario.description, template });
    const entry: Record<string, unknown> = {
      slug: agent.slug, from: `agent v${agent.version}`, legacy: `v${from.version}`, questions: pkg.items.length,
      skillSha256: createHash("sha256").update(pkg.skill).digest("hex").slice(0, 16),
      // Kept from the live role play, not the port: the trainer may have changed these since.
      keeps: Object.keys(current).filter((key) => !PACKAGE_DERIVED.has(key)),
      missingSwitches: missingSwitches(pkg.skill, asRecord(current.tools)),
      character: row === null ? `persona ${agent.persona.slug} not in pool` : writeCharacter ? "write" : "keep (edited; --force-character to replace)",
    };
    if (options.apply) {
      // A new package; every setting on the live role play (anything the package does not derive) carries over as is.
      const settings = Object.fromEntries(Object.entries(current).filter(([key]) => !PACKAGE_DERIVED.has(key)));
      const published = await publishInterviewSkill(org.id, {
        personaSlug: agent.persona.slug, scenario: { ...pkg.scenario, name: agent.name }, skill: pkg.skill, items: pkg.items, slug: agent.slug, settings,
      });
      if (row && writeCharacter) {
        await db.agentPersona.updateMany({ where: { agentId: agent.id, personaId: agent.persona.id }, data: { character } });
      }
      Object.assign(entry, { version: published.version, created: published.created });
    }
    report.push(entry);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) await main();
