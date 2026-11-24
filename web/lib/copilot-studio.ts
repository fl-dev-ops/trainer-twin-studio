import { resolveUpload, UploadError } from "@/lib/uploads";
import { z } from "zod";
import { botBySlug, createBot, listBots, requireBots, publicSettingsOf, saveBotDetails, saveBotSkills, type PublicBot } from "@/lib/bots";
import { setAgentPersonas } from "@/lib/agent-personas";
import { setSupportingSkills } from "@/lib/agent-skills";
import { toolSettings } from "@/lib/agent-tools";
import { beforeSettings } from "@/lib/context-upload";
import { db, withLock } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { LEARNER, orgPeople } from "@/lib/org-people";
import { updateRoleplay } from "@/lib/roleplay/manage";
import { roleplayBuilderFrom } from "@/lib/roleplay/skill";
import { getObjectText } from "@/lib/s3";
import { publishRoleplayBrief, ROLEPLAY_SOURCE, ScenarioIngestError, TWIN_SKILL_SOURCE } from "@/lib/scenario-ingest";
import { draftBrief } from "@/lib/roleplay/brief";
import { updateTwin } from "@/lib/twin/manage";
import { personaFromStored, personaInputSchema } from "@/lib/persona";
import { PersonaError, savePersona } from "@/lib/personas";
import { listAvailableVoices } from "@/lib/voices";
import { ensureTwin, TWIN_SOURCE, TwinError } from "@/lib/twins";
import { readSkillPackage, skillRefusals } from "@/lib/skills";
import { getMappedSkillPackage, hydrateAgentSkill } from "@/lib/skill-history";

const slug = z.string().trim().min(1).max(200);
const before = z.object({
  preScreenshare: z.boolean(), preUpload: z.boolean(), preUploadRequired: z.boolean(), duringUpload: z.boolean(),
  uploadTitle: z.string().trim().max(80), uploadInstruction: z.string().trim().max(300),
  callMinutes: z.number().int().min(1).max(60).nullable(),
}).partial().strict();
const tools = z.object({ canvas: z.boolean(), codeEditor: z.boolean(), preview: z.boolean(), choice: z.boolean(), knowledge: z.boolean() }).partial().strict();

export const copilotStudioInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("context") }).strict(),
  // kind: the copilot's list_twins / list_roleplays and get_twin / get_roleplay read only their own module.
  z.object({ action: z.literal("list"), kind: z.enum(["twin", "roleplay"]).optional(), includeArchived: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("get"), slug, kind: z.enum(["twin", "roleplay"]).optional() }).strict(),
  z.object({ action: z.literal("getSkill"), slug, version: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal("listKnowledge") }).strict(),
  z.object({ action: z.literal("listUsers"), name: z.string().trim().min(1).max(120).optional(), offset: z.number().int().nonnegative().max(2_147_483_647).optional() }).strict(),
  // The copilot channel's fetchFile (trainertwin-upload://<id>): a file this trainer attached in a copilot chat.
  z.object({ action: z.literal("resolveUpload"), documentId: z.string().trim().min(1).max(120) }).strict(),
  z.object({
    action: z.literal("updateTwin"), slug,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    settings: before.optional(),
  }).strict(),
  z.object({
    action: z.literal("updateRoleplay"), slug,
    // Builder fields (validated whole by the builder schema after merging).
    builder: z.record(z.string(), z.unknown()).optional(),
    before: before.optional(),
    tools: tools.optional(),
  }).strict(),
  // Role plays written from requirements (lib/roleplay/brief.ts): personas to play them, a draft (check + render, nothing
  // saved), and publishing on the trainer's approval.
  z.object({ action: z.literal("listPersonas") }).strict(),
  // A new role-play persona (the Personas page's form: name, role, about, a voice), on the trainer's approval.
  z.object({ action: z.literal("listVoices") }).strict(),
  personaInputSchema.extend({ action: z.literal("createPersona") }).strict(),
  // Edit a role-play persona: only the fields passed change. The trainer's own persona is edited in Personas.
  personaInputSchema.partial().extend({ action: z.literal("updatePersona"), slug }).strict(),
  z.object({ action: z.literal("draftRoleplay"), brief: z.unknown() }).strict(),
  z.object({ action: z.literal("publishRoleplay"), persona: slug, brief: z.unknown() }).strict(),
  z.object({ action: z.literal("createTwin"), persona: slug }).strict(),
  // Supporting skills and personas (specs/agents.md), by slug; bots by slug.
  z.object({ action: z.literal("setTwinSkills"), slug, skills: z.array(z.object({ slug, active: z.boolean() })).max(50) }).strict(),
  z.object({ action: z.literal("setRoleplayPersonas"), slug, extras: z.array(z.object({ slug, active: z.boolean() })).max(20) }).strict(),
  // One persona's character for one role play (AgentPersona.character): written for that pair only. "" clears it.
  z.object({ action: z.literal("setRoleplayCharacter"), slug, persona: slug, character: z.string().max(20000) }).strict(),
  z.object({ action: z.literal("listBots") }).strict(),
  z.object({ action: z.literal("getBot"), slug }).strict(),
  z.object({ action: z.literal("createBot"), persona: slug, name: z.string().trim().min(1).max(120), objective: z.string().trim().min(1).max(2000) }).strict(),
  z.object({
    action: z.literal("updateBot"), slug,
    persona: slug.optional(), name: z.string().trim().min(1).max(120).optional(), objective: z.string().trim().min(1).max(2000).optional(),
    skills: z.array(z.object({ slug, active: z.boolean() })).max(50).optional(),
  }).strict(),
]);
export type CopilotStudioInput = z.infer<typeof copilotStudioInput>;
export type Actor = { org: { id: string; slug: string }; user: { id: string; name: string } };

const defaultDeps = { db, getObjectText, savePersona, listAvailableVoices, ensureTwin, updateTwin, updateRoleplay, resolveUpload, publishRoleplayBrief };
export type CopilotStudioDeps = typeof defaultDeps;

const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** What an agent is, in the copilot's words. */
function kindOf(agent: { kind: string; data: unknown }) {
  const source = asRecord(agent.data).source;
  if (agent.kind === "TWIN") return source === TWIN_SOURCE ? "main-twin" : source === TWIN_SKILL_SOURCE ? "twin-skill" : "twin-skill-legacy";
  if (asRecord(agent.data).roleplayBrief) return "roleplay-brief";
  return source === ROLEPLAY_SOURCE ? "roleplay-builder" : "roleplay-recordings";
}

async function findAgent(d: CopilotStudioDeps, orgId: string, agentSlug: string, opts: { archived?: boolean } = {}) {
  const agent = await d.db.agent.findFirst({
    where: { orgId, slug: agentSlug, ...(opts.archived === undefined ? {} : { archivedAt: opts.archived ? { not: null } : null }) },
    select: { id: true, slug: true, name: true, kind: true, version: true, primarySkillId: true, data: true, archivedAt: true, updatedAt: true },
  });
  // Bots are managed from their twin's settings, not by the copilot.
  if (!agent || agent.kind === "BOT") throw new ScenarioIngestError(`"${agentSlug}" was not found${opts.archived ? " among archived items" : ""}`, 404);
  return agent;
}


export async function runCopilotStudio(actor: Actor, input: CopilotStudioInput, d: CopilotStudioDeps = defaultDeps) {
  const orgId = actor.org.id;
  switch (input.action) {
    case "context": {
      // Who the copilot works for: the org and its trainers' own personas (the USER / persona of the skill tools).
      const personas = await d.db.persona.findMany({ where: { orgId, isOwn: true }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } });
      return { org: actor.org.slug, trainer: actor.user.name, personas };
    }

    case "list": {
      const agents = await d.db.agent.findMany({
        where: {
          orgId,
          ...(input.kind ? { kind: input.kind === "twin" ? "TWIN" : "ROLEPLAY" } : {}),
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        select: { id: true, primarySkillId: true, slug: true, name: true, kind: true, version: true, data: true, archivedAt: true, updatedAt: true },
      });
      // Bots are managed from their twin's settings, not by the copilot.
      const hydrated = await Promise.all(agents.filter((agent) => agent.kind !== "BOT").map((agent) => hydrateAgentSkill(orgId, agent, d.db)));
      return {
        items: hydrated.map((agent) => ({
          slug: agent.slug,
          name: agent.name,
          kind: kindOf(agent),
          // The twin-creator / roleplay-creator id a skill update must keep.
          skillId: text(asRecord(asRecord(agent.data).scenario).skill) ?? text(asRecord(asRecord(agent.data).scenario).scenario),
          version: agent.version,
          description: text(asRecord(agent.data).objective),
          archived: agent.archivedAt !== null,
          updatedAt: agent.updatedAt.toISOString(),
        })),
      };
    }

    case "get": {
      const stored = await findAgent(d, orgId, input.slug);
      if (input.kind && (stored.kind === "TWIN") !== (input.kind === "twin")) {
        throw new ScenarioIngestError(`"${input.slug}" is a ${stored.kind === "TWIN" ? "twin" : "role play"}, not a ${input.kind === "twin" ? "twin" : "role play"}`, 400);
      }
      const agent = await hydrateAgentSkill(orgId, stored, d.db);
      const kind = kindOf(agent);
      const base = {
        slug: agent.slug, name: agent.name, kind, version: agent.version, archived: agent.archivedAt !== null,
        description: text(asRecord(agent.data).objective), settings: beforeSettings(agent.data),
      };
      if (agent.kind === "TWIN") return base;
      return {
        ...base,
        tools: toolSettings(agent.data),
        builder: kind === "roleplay-builder" ? roleplayBuilderFrom(agent.data) : null,
        // A role play written from requirements: its brief, which an edit changes (then publishRoleplay again).
        brief: kind === "roleplay-brief" ? asRecord(agent.data).roleplayBrief : null,
        // Who may play it, in order, each with its character for this role play ("" when none is written yet).
        personas: (await d.db.agentPersona.findMany({
          where: { agentId: agent.id }, orderBy: { position: "asc" },
          select: { active: true, character: true, persona: { select: { id: true, slug: true, name: true, agents: { where: { id: agent.id }, select: { id: true } } } } },
        })).map((row) => ({ slug: row.persona.slug, name: row.persona.name, active: row.active, main: row.persona.agents.length > 0, character: row.character ?? "" })),
      };
    }

    case "getSkill": {
      // A published skill package (twin skill or role play): the baseline for an update, or an older version to restore.
      const agent = await findAgent(d, orgId, input.slug);
      const version = input.version ?? agent.version;
      const mapped = await getMappedSkillPackage(orgId, agent.id, version, d.db, { verifyFiles: true });
      const data = mapped ? {} : version === agent.version
        ? asRecord(agent.data)
        : asRecord((await d.db.specVersion.findFirst({ where: { orgId, entityType: "agents", entitySlug: agent.slug, version }, select: { data: true } }))?.data);
      const artifacts = mapped?.version.artifacts ?? text(data.artifacts);
      const managed = mapped ?? (agent.primarySkillId && artifacts
        ? await readSkillPackage(orgId, agent.slug, agent.primarySkillId, artifacts, d.db)
        : null);
      if (agent.primarySkillId && version === agent.version && !managed) throw skillRefusals.unavailable();
      if (!managed && (!artifacts || typeof data.skill !== "string")) throw new ScenarioIngestError(`"${agent.slug}" v${version} has no published skill files`, 404);
      const packageFiles = managed?.files;
      if (managed && !packageFiles) throw skillRefusals.unavailable();
      const manifestFile = agent.kind === "TWIN" ? "skill.json" : "scenario.json";
      const read = (file: string) => d.getObjectText(`${artifacts}/${file}`).catch(() => null);
      const [manifest, items, patterns] = packageFiles && managed
        ? [packageFiles[managed.version.format === "twin" ? "skill.json" : "scenario.json"], packageFiles["items.json"], packageFiles["patterns.md"] ?? null]
        : await Promise.all([read(manifestFile), read("items.json"), read("patterns.md")]);
      const [versions, mappings] = await Promise.all([
        d.db.specVersion.findMany({
          where: { orgId, entityType: "agents", entitySlug: agent.slug },
          orderBy: { version: "desc" },
          select: { version: true, createdAt: true },
        }),
        d.db.agentSkillVersion.findMany({
          where: { orgId, agentId: agent.id, agent: { orgId }, version: { skill: { orgId, ownerSlug: agent.slug } } },
          select: { agentVersion: true, createdAt: true },
        }),
      ]);
      const history = new Map(mappings.map((row) => [row.agentVersion, row.createdAt]));
      for (const row of versions) history.set(row.version, row.createdAt);
      history.delete(agent.version);
      return {
        slug: agent.slug,
        kind: managed ? managed.version.format === "twin" ? "twin-skill"
          : managed.version.format === "legacy-twin" ? "twin-skill-legacy"
            : managed.version.format === "builder-roleplay" ? "roleplay-builder" : "roleplay-recordings" : kindOf(agent),
        name: agent.name,
        version,
        currentVersion: agent.version,
        versions: [{ version: agent.version, current: true }, ...[...history].sort(([a], [b]) => b - a).map(([version, createdAt]) => ({ version, savedAt: createdAt.toISOString() }))],
        skill: managed?.version.skillText ?? data.skill,
        manifest: manifest ? JSON.parse(manifest) : asRecord(data.scenario),
        items: items ? JSON.parse(items) : [],
        patterns,
      };
    }

    case "listUsers": {
      const limit = 25;
      const offset = input.offset ?? 0;
      const rows = await orgPeople(orgId, { includeDisabled: true, nameQuery: input.name, skip: offset, take: limit + 1 }, d.db);
      const people = rows.slice(0, limit);
      const learners = people.filter((person) => person.role === LEARNER && !person.disabled);
      const live = { orgId, archivedAt: null };
      const [twins, roleplays] = learners.length ? await Promise.all([
        d.db.twinAssignment.findMany({
          where: { orgId, userId: { in: learners.map((person) => person.userId) }, status: "active",
            OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }], agent: { ...live, kind: "TWIN" } },
          select: { userId: true, agent: { select: { name: true, slug: true } } },
          orderBy: [{ agent: { name: "asc" } }, { agent: { slug: "asc" } }],
        }),
        d.db.rolePlayAssignment.findMany({
          where: { orgId, memberId: { in: learners.map((person) => person.memberId) }, status: { in: ["pending", "used"] },
            deployment: { orgId, status: "active", agent: { ...live, kind: "ROLEPLAY" } } },
          select: { memberId: true, deployment: { select: { agent: { select: { name: true, slug: true } } } } },
          orderBy: [{ deployment: { agent: { name: "asc" } } }, { deployment: { agent: { slug: "asc" } } }],
        }),
      ]) : [[], []];
      return {
        users: people.map((person) => ({
          name: person.name.trim().toLowerCase() === person.email ? "Unnamed user" : person.name,
          role: person.role === LEARNER ? "learner" : person.role,
          disabled: person.disabled,
          twins: twins.filter((row) => row.userId === person.userId).map((row) => row.agent),
          roleplays: roleplays.filter((row) => row.memberId === person.memberId).map((row) => row.deployment.agent),
        })),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    }

    case "listKnowledge": {
      const docs = await d.db.knowledgeDocument.findMany({
        where: { kb: { orgId }, status: { not: "failed" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, ext: true, createdAt: true },
      });
      return { docs: docs.map((doc) => ({ id: doc.id, title: doc.title, ext: doc.ext, addedAt: doc.createdAt.toISOString() })) };
    }

    case "resolveUpload": {
      try {
        // The copilot's model reads images, not PDFs: a PDF comes as its text.
        return await d.resolveUpload({ orgId, id: input.documentId, ownerUserId: actor.user.id, pdfAsText: true });
      } catch (error) {
        if (error instanceof UploadError) throw new ScenarioIngestError(error.message, error.status);
        throw error;
      }
    }

    case "updateTwin":
      await findAgent(d, orgId, input.slug, { archived: false });
      return d.updateTwin(orgId, input.slug, { name: input.name, description: input.description, settings: input.settings });

    case "updateRoleplay":
      return d.updateRoleplay(orgId, input.slug, { builder: input.builder as never, before: input.before, tools: input.tools });

    case "listPersonas": {
      // Who can play a role play: the org's personas (personality and voice). The skill never redefines them.
      const personas = await d.db.persona.findMany({
        where: { orgId }, orderBy: [{ isOwn: "desc" }, { name: "asc" }],
        select: { slug: true, name: true, isOwn: true, data: true, voice: { select: { name: true } }, _count: { select: { agentLinks: { where: { agent: { archivedAt: null } } } } } },
      });
      return {
        personas: personas.map((p) => ({
          slug: p.slug, name: p.name, own: p.isOwn,
          role: text(asRecord(p.data).role) ?? null, about: text(asRecord(p.data).background) ?? null,
          voice: p.voice?.name ?? null, usedBy: p._count.agentLinks,
        })),
      };
    }

    case "listVoices": {
      const voices = await d.listAvailableVoices(orgId);
      // The voice library: ids and names never change; gender, age and accent are what the copilot matches a persona to.
      return { voices: voices.map((v) => ({ id: v.id, name: v.name, own: v.orgId === orgId, language: v.language, gender: v.gender, age: v.age, accent: v.accent })) };
    }

    case "createPersona": {
      const { action: _action, ...fields } = input;
      try {
        const created = await d.savePersona(orgId, fields);
        return { ok: true, slug: created.slug, name: fields.name, role: fields.role, voice: fields.voiceId ?? null };
      } catch (error) {
        if (error instanceof PersonaError) throw new ScenarioIngestError(error.message, error.status);
        throw error;
      }
    }

    case "updatePersona": {
      const { action: _action, slug: personaSlug, ...patch } = input;
      const existing = await d.db.persona.findFirst({ where: { orgId, slug: personaSlug }, select: { name: true, isOwn: true, data: true } });
      if (!existing) throw new ScenarioIngestError(`Persona "${personaSlug}" was not found`, 404);
      if (existing.isOwn) throw new ScenarioIngestError("The trainer's own persona is edited in Personas, not from the copilot", 403);
      const current = personaFromStored(existing.name, existing.data);
      try {
        const saved = await d.savePersona(orgId, { ...current, ...patch }, personaSlug);
        return { ok: true, slug: saved.slug, version: saved.version, changed: Object.keys(patch), appliesTo: "later sessions of every role play using this persona" };
      } catch (error) {
        if (error instanceof PersonaError) throw new ScenarioIngestError(error.message, error.status);
        throw error;
      }
    }

    case "draftRoleplay": {
      const draft = draftBrief(input.brief);
      return draft.ok
        ? { ok: true, skill: draft.skill, learnerBrief: draft.brief.learnerBrief, items: draft.items.length, slug: `${actor.org.slug}-${draft.brief.id}` }
        : { ok: false, reasons: draft.reasons, ...("skill" in draft ? { skill: draft.skill } : {}) };
    }

    case "publishRoleplay": {
      const existing = await d.db.agent.findFirst({ where: { orgId, slug: `${actor.org.slug}-${asRecord(input.brief).id}` }, select: { kind: true, data: true } });
      if (existing && (existing.kind !== "ROLEPLAY" || (!asRecord(existing.data).roleplayBrief && asRecord(existing.data).skill))) {
        throw new ScenarioIngestError("A different role play or twin already uses this id; choose another brief id.", 409);
      }
      const published = await d.publishRoleplayBrief(orgId, { personaSlug: input.persona, brief: input.brief }, { disallowRestore: true });
      return { ok: true, slug: published.slug, name: published.name, version: published.version, created: published.created, items: published.items };
    }

    case "createTwin": {
      try {
        return { ok: true, ...await d.ensureTwin(orgId, input.persona) };
      } catch (error) {
        if (error instanceof TwinError) throw new ScenarioIngestError(error.message, error.status);
        throw error;
      }
    }

    case "setTwinSkills": {
      const twin = await findAgent(d, orgId, input.slug, { archived: false });
      if (twin.kind !== "TWIN" || asRecord(twin.data).source !== TWIN_SOURCE) throw new ScenarioIngestError(`"${input.slug}" is not a main twin`, 400);
      const skills = await skillIdsBySlug(orgId, input.skills);
      await withLock([`agent:${twin.slug}`], (tx) => setSupportingSkills(orgId, twin.id, skills, tx));
      return { ok: true, skills: input.skills };
    }

    case "setRoleplayPersonas": {
      const roleplay = await findAgent(d, orgId, input.slug, { archived: false });
      if (roleplay.kind !== "ROLEPLAY") throw new ScenarioIngestError(`"${input.slug}" is not a role play`, 400);
      await withLock([`agent:${roleplay.slug}`], async (tx) => {
        const main = (await tx.agent.findUniqueOrThrow({ where: { id: roleplay.id }, select: { personaId: true } })).personaId;
        const extras = await personaIdsBySlug(orgId, input.extras.map((row) => row.slug), tx);
        await setAgentPersonas(roleplay.id, [
          { personaId: main, active: true },
          ...input.extras.map((row) => ({ personaId: extras.get(row.slug)!, active: row.active })).filter((row) => row.personaId !== main),
        ], tx);
      });
      return { ok: true, extras: input.extras };
    }

    case "setRoleplayCharacter": {
      const roleplay = await findAgent(d, orgId, input.slug, { archived: false });
      if (roleplay.kind !== "ROLEPLAY") throw new ScenarioIngestError(`"${input.slug}" is not a role play`, 400);
      const updated = await d.db.agentPersona.updateMany({
        where: { agentId: roleplay.id, persona: { slug: input.persona } },
        data: { character: input.character.trim() || null },
      });
      if (!updated.count) throw new ScenarioIngestError(`"${input.persona}" does not play this role play; add it with setRoleplayPersonas first`, 400);
      return { ok: true, persona: input.persona, written: Boolean(input.character.trim()) };
    }

    case "listBots":
      await requireBots(orgId);
      return { items: (await listBots(orgId)).map(botSummary) };

    case "getBot": {
      await requireBots(orgId);
      const bot = await botBySlug(orgId, input.slug);
      if (!bot) throw new ScenarioIngestError(`Bot "${input.slug}" was not found`, 404);
      return { ...botSummary(bot), objective: asRecord(bot.data).objective ?? "" };
    }

    case "createBot": {
      await requireBots(orgId);
      const persona = (await personaIdsBySlug(orgId, [input.persona])).get(input.persona)!;
      const bot = await db.$transaction((tx) => createBot(orgId, { personaId: persona, name: input.name, objective: input.objective }, tx));
      return { ok: true, slug: bot?.slug, publicCalls: "off" };
    }

    case "updateBot": {
      await requireBots(orgId);
      const personaId = input.persona ? (await personaIdsBySlug(orgId, [input.persona])).get(input.persona) : undefined;
      const skills = input.skills ? await skillIdsBySlug(orgId, input.skills) : undefined;
      await withLock([`agent:${input.slug}`], async (tx) => {
        let bot = await botBySlug(orgId, input.slug, tx);
        if (!bot) throw new ScenarioIngestError(`Bot "${input.slug}" was not found`, 404);
        if (input.name !== undefined || input.objective !== undefined || personaId) bot = await saveBotDetails(bot, { name: input.name, objective: input.objective, personaId }, tx);
        if (bot && skills) await saveBotSkills(bot, skills, tx);
      });
      return { ok: true };
    }
  }
}

/** A bot as the copilot sees it: no websites or public switches (those stay with the trainer, under Bots). */
function botSummary(bot: PublicBot) {
  return {
    slug: bot.slug, name: bot.name, persona: bot.persona.slug, version: bot.version,
    skills: bot.supportingSkills.map((row) => ({ slug: row.skill.ownerSlug, name: row.skill.name, active: row.active })),
    publicCalls: publicSettingsOf(bot.deployment).enabled ? "on" : "off",
  };
}

/** Library skills by their slugs (published twin skills of the org), in the order given. */
async function skillIdsBySlug(orgId: string, rows: { slug: string; active: boolean }[]) {
  const skills = await db.skill.findMany({ where: { orgId, ownerSlug: { in: rows.map((row) => row.slug) } }, select: { id: true, ownerSlug: true } });
  const idOf = new Map(skills.map((skill) => [skill.ownerSlug, skill.id]));
  const missing = rows.find((row) => !idOf.has(row.slug));
  if (missing) throw new ScenarioIngestError(`Skill "${missing.slug}" was not found among the published skills`, 404);
  return rows.map((row) => ({ skillId: idOf.get(row.slug)!, active: row.active }));
}

/** Personas by slug: the org's and the global library's. */
async function personaIdsBySlug(orgId: string, slugs: string[], client: Prisma.TransactionClient = db) {
  const rows = await client.persona.findMany({ where: { slug: { in: slugs }, OR: [{ orgId }, { orgId: null }] }, select: { id: true, slug: true, orgId: true } });
  const idOf = new Map<string, string>();
  for (const row of rows) if (!idOf.has(row.slug) || row.orgId) idOf.set(row.slug, row.id);
  const missing = slugs.find((value) => !idOf.has(value));
  if (missing) throw new ScenarioIngestError(`Persona "${missing}" was not found`, 404);
  return idOf;
}
