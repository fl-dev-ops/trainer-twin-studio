import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { beforeSettings } from "@/lib/context-upload";
import { db, withLock } from "@/lib/db";
import { ownershipLock, packageFieldsOmitted, skillOwnership } from "@/lib/skill-ownership";
import { reportStateOf, type ReportState } from "@/lib/report-model";
import { refusals } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { assignablePeople } from "@/lib/learners";
import { orgPeople } from "@/lib/org-people";
import { creditsLeftFor } from "@/lib/minutes";
import { listPersonas } from "@/lib/personas";
import { isSessionReport } from "@/lib/session-report";
import { type RoleplayBuilder, roleplayBuilderFrom, roleplayBuilderSchema } from "@/lib/roleplay/skill";
import { updateRoleplay } from "@/lib/roleplay/manage";
import { type RoleplayBrief, roleplayBriefSchema } from "@/lib/roleplay/brief";
import { type RoleplayReport } from "@/lib/roleplay/session-report";
import { publishRoleplayBrief, ROLEPLAY_SOURCE, saveRoleplay, ScenarioIngestError } from "@/lib/scenario-ingest";
import { studioProcedure, t } from "@/lib/trpc";
import { avatarPhotoUrl } from "@/lib/twin/avatar";
import { durationSeconds, transcriptTurns } from "@/lib/twin/stats";
import { toolSettings, toolSettingsInput } from "@/lib/agent-tools";
import { hydrateAgentSkill } from "@/lib/skill-history";
import { skillRefusals } from "@/lib/skills";
import { dashRoute } from "@/lib/routes";
import { setAgentPersonas } from "@/lib/agent-personas";

/**
 * Role-play tRPC surface, mounted at /api/roleplay (the twin module's twin, plans/roleplay-skill.md step 6).
 * Studio members only; every query is scoped to their organization. Covers role plays built in the builder
 * (source "roleplay-skill"), authored skills (ported interviews) and copilot briefs.
 */

const slugInput = z.object({ slug: z.string().min(1).max(200) });
const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Builder role plays of the org (detail, builder, assign and their session reports). */
const roleplaysOf = (orgId: string): Prisma.AgentWhereInput => ({
  orgId,
  kind: "ROLEPLAY",
  // Builder role plays, and role plays the copilot wrote from requirements (a brief, lib/roleplay/brief.ts).
  // Also role plays with an authored skill (ported interviews, data.source "scenario-ingest").
  OR: [
    { data: { path: ["source"], equals: ROLEPLAY_SOURCE } },
    { data: { path: ["roleplayBrief", "id"], string_starts_with: "" } },
    { data: { path: ["source"], equals: AUTHORED_SOURCE } },
  ],
});

/** A role play's brief, when the copilot wrote it from requirements. */
const briefOf = (data: unknown): RoleplayBrief | null => {
  const parsed = roleplayBriefSchema.safeParse(asRecord(data).roleplayBrief);
  return parsed.success ? parsed.data : null;
};

/** What the trainer reads of a brief: who plays whom, the situation, how it goes and how it ends. */
function scriptOf(brief: RoleplayBrief) {
  return {
    aiRole: brief.ai.role,
    who: brief.ai.who,
    learnerRole: brief.learner.role,
    learnerAim: brief.learner.aim,
    situation: brief.situation,
    wants: brief.wants,
    concerns: brief.concerns.map((c) => ({ concern: c.concern, hidden: c.hidden })),
    steps: brief.steps.map((step) => ({ name: step.name, what: step.what })),
    ending: { limit: brief.ending.limit ?? null, good: brief.ending.good },
    items: brief.items.length,
  };
}

const AUTHORED_SOURCE = "scenario-ingest";

/** A role play with an authored skill (a ported interview): what its scenario.json says, for the script view. */
function authoredScriptOf(data: unknown) {
  const scenario = asRecord(asRecord(data).scenario);
  const steps = Array.isArray(scenario.steps) ? scenario.steps.map(asRecord) : [];
  return {
    aiRole: text(scenario.trainer_role) ?? "Interviewer",
    who: "Follows the role play's skill.",
    learnerRole: text(scenario.learner_role) ?? "Learner",
    learnerAim: "",
    situation: [text(scenario.description)].filter((v): v is string => Boolean(v)),
    wants: "",
    concerns: [] as { concern: string; hidden: boolean }[],
    steps: steps.map((step) => ({ name: text(step.name) ?? text(step.id) ?? "Step", what: "" })).filter((step) => step.name),
    ending: { limit: null as string | null, good: "" },
    items: 0,
  };
}

/** The same reading of a role play made in the older form: its fields as the script view shows them. */
function builderScriptOf(b: RoleplayBuilder) {
  const lines = (...values: (string | undefined)[]) => values.map((v) => (v ?? "").trim()).filter(Boolean);
  return {
    aiRole: "Client",
    who: lines(b.clientName ? `On this call your name is ${b.clientName}.` : "", b.howTheyTalk).join(" ") || "The persona, as they are.",
    learnerRole: b.situation.learnerRole,
    learnerAim: b.learnerGoals.join(" ") || "Get to a clear next step.",
    situation: lines(b.situation.scenario),
    wants: "",
    concerns: lines(b.situation.hiddenTruth).map((concern) => ({ concern, hidden: true })),
    steps: [] as { name: string; what: string }[],
    ending: { limit: null as string | null, good: lines(b.situation.agreesWhen ? `Agrees when: ${b.situation.agreesWhen}` : "", b.situation.declinesWhen ? `Declines when: ${b.situation.declinesWhen}` : "").join(" ") },
    items: b.exampleLines.length,
  };
}
/**
 * Every role play of the org, for the library, sessions and users lists: builder role plays plus the v1 interview
 * scenarios (no builder source); their old sessions keep the interview report page (/sessions/<id>).
 */
const anyRoleplayOf = (orgId: string): Prisma.AgentWhereInput => ({ orgId, kind: "ROLEPLAY" });

const personaSelect = { slug: true, name: true, data: true, avatar: { select: { s3ImageKey: true, updatedAt: true } } } as const;
type PersonaRow = Prisma.PersonaGetPayload<{ select: typeof personaSelect }>;

/** The client the learner talks to: the role play's own client name, else the persona's; the persona's photo. */
function clientOf(persona: PersonaRow, data: unknown) {
  const builder = asRecord(asRecord(asRecord(data).scenario).roleplay);
  const personaData = asRecord(persona.data);
  return {
    name: text(builder.clientName) ?? text(personaData.name) ?? persona.name,
    role: text(personaData.role),
    persona: persona.slug,
    photoUrl: avatarPhotoUrl(persona.slug, persona.avatar),
  };
}

async function findRoleplay(orgId: string, slug: string) {
  const agent = await db.agent.findFirst({
    where: { ...roleplaysOf(orgId), slug, archivedAt: null },
    select: { id: true, slug: true, version: true, primarySkillId: true, name: true, data: true, updatedAt: true, persona: { select: personaSelect } },
  });
  if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Role play not found" });
  return agent.primarySkillId ? hydrateAgentSkill(orgId, agent) : agent;
}

/** A finished role-play session's report, once made. */
const roleplayReport = (value: unknown): RoleplayReport | null =>
  isSessionReport(value) && asRecord(value).kind === "roleplay" ? (value as RoleplayReport) : null;

/** A report written by the legacy interview runtime (any finished report that is not a role-play report). */
const legacyReport = (value: unknown) => isSessionReport(value) && asRecord(value).kind !== "roleplay";

/** Where a session's report stands, for quiet polling (the same states as twin: lib/report-model.ts). */
export type RoleplayReportState = ReportState;
const reportState = (row: Parameters<typeof reportStateOf>[0], now = Date.now()) => reportStateOf(row, (report) => Boolean(roleplayReport(report)), now);

const sessionSelect = {
  id: true, agentId: true, status: true, reportStatus: true, report: true, startedAt: true, endedAt: true, createdAt: true,
  user: { select: { name: true, email: true, image: true } },
  agent: { select: { slug: true, name: true } },
} as const;
type SessionRow = Prisma.InterviewSessionGetPayload<{ select: typeof sessionSelect }>;

function sessionItem(row: SessionRow) {
  if (!row.user) throw new Error("Role-play sessions require an account");
  const report = roleplayReport(row.report);
  return {
    id: row.id,
    learner: { name: row.user.name || row.user.email, email: row.user.email, image: row.user.image },
    roleplay: { slug: row.agent.slug, name: row.agent.name },
    at: (row.startedAt ?? row.createdAt).toISOString(),
    seconds: durationSeconds(row.startedAt, row.endedAt),
    status: row.status,
    score: typeof report?.score === "number" ? report.score : null,
    summary: report?.summary ?? null,
    reportState: reportState(row),
    href: dashRoute(`/roleplay/sessions/${row.id}`),
  };
}

/** Sessions on builder role plays, newest first (calibration-free: role plays have none). */
const roleplaySessions = (orgId: string, extra: Prisma.InterviewSessionWhereInput = {}): Prisma.InterviewSessionWhereInput => ({
  orgId, deletedAt: null, startedAt: { not: null }, agent: roleplaysOf(orgId), ...extra,
});
/** Sessions on any role play, v1 interview scenarios included. */
const anyRoleplaySessions = (orgId: string): Prisma.InterviewSessionWhereInput => ({
  orgId, deletedAt: null, startedAt: { not: null }, agent: anyRoleplayOf(orgId),
});

/** The org's members given a role play (RolePlayAssignment), with who they are and the assignment's status. */
async function invitesFor(orgId: string, agentIds: string[]) {
  const rows = await db.rolePlayAssignment.findMany({
    where: { orgId, deployment: { agentId: { in: agentIds } } },
    orderBy: { assignedAt: "desc" },
    select: { id: true, memberId: true, status: true, assignedAt: true, expiresAt: true, deployment: { select: { agentId: true } } },
  });
  // The org's learners only (specs/people.md rule 7: admin and team hold no learner assignments).
  const people = new Map((await orgPeople(orgId, { roles: ["user"], memberIds: [...new Set(rows.map((row) => row.memberId))], includeDisabled: true }))
    .map((person) => [person.memberId, person]));
  return rows.flatMap((row) => {
    const person = people.get(row.memberId);
    return person ? [{ ...row, agentId: row.deployment.agentId, name: person.name, email: person.email, image: person.image }] : [];
  });
}

const scenariosRouter = t.router({
  /** The Scenarios library: one card per role play with its client, opening line and learners. */
  list: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const rows = await db.agent.findMany({
      where: { ...roleplaysOf(orgId), archivedAt: null },
      orderBy: [{ order: "asc" }, { updatedAt: "desc" }],
      select: { id: true, slug: true, version: true, primarySkillId: true, name: true, data: true, updatedAt: true, persona: { select: personaSelect } },
    });
    const agents = await Promise.all(rows.map((agent) => agent.primarySkillId ? hydrateAgentSkill(orgId, agent) : agent));
    const ids = agents.map((agent) => agent.id);
    const [invites, sessions] = await Promise.all([
      invitesFor(orgId, ids),
      db.interviewSession.groupBy({ by: ["agentId"], where: { orgId, agentId: { in: ids }, deletedAt: null, startedAt: { not: null } }, _count: true }),
    ]);
    const sessionsOf = new Map(sessions.map((row) => [row.agentId, row._count]));
    return agents.map((agent) => {
      const data = asRecord(agent.data);
      const scenario = asRecord(data.scenario);
      const brief = briefOf(data);
      return {
        slug: agent.slug,
        name: agent.name,
        href: dashRoute(`/roleplay/${agent.slug}`),
        description: text(scenario.description),
        opening: text(asRecord(scenario.roleplay).opening) ?? text(brief?.start.openingLine),
        client: clientOf(agent.persona, agent.data),
        sessions: sessionsOf.get(agent.id) ?? 0,
        updatedAt: agent.updatedAt.toISOString(),
        learners: invites
          .filter((row) => row.agentId === agent.id)
          .map((row) => ({ name: row.name, email: row.email, image: row.image })),
      };
    });
  }),

  /** One role play: client, scenario, stats, members and recent sessions. */
  get: studioProcedure.input(slugInput).query(async ({ ctx, input }) => {
    const orgId = ctx.user.orgId;
    const agent = await findRoleplay(orgId, input.slug);
    const [invites, rows] = await Promise.all([
      invitesFor(orgId, [agent.id]),
      db.interviewSession.findMany({ where: roleplaySessions(orgId, { agentId: agent.id }), orderBy: { startedAt: "desc" }, take: 200, select: sessionSelect }),
    ]);
    const sessions = rows.map(sessionItem);
    const scored = sessions.map((s) => s.score).filter((s): s is number => s !== null);
    const lengths = sessions.map((s) => s.seconds).filter((s): s is number => s !== null);
    const average = (list: number[]) => (list.length ? list.reduce((sum, n) => sum + n, 0) / list.length : null);
    const builder = roleplayBuilderFrom(agent.data);
    const brief = briefOf(agent.data);
    return {
      slug: agent.slug,
      name: agent.name,
      description: text(asRecord(asRecord(agent.data).scenario).description),
      situation: builder?.situation.scenario ?? brief?.summary ?? null,
      learnerRole: builder?.situation.learnerRole ?? brief?.learner.role ?? null,
      /** Written by the copilot: the script the trainer reads (changed through the copilot or the edit page's core fields). */
      script: brief ? scriptOf(brief) : builder ? builderScriptOf(builder) : authoredScriptOf(agent.data),
      difficulty: builder?.difficulty ?? null,
      client: clientOf(agent.persona, agent.data),
      stats: {
        sessions: sessions.length,
        averageScore: scored.length ? Math.round(average(scored)!) : null,
        averageMinutes: lengths.length ? Math.round((average(lengths)! / 60) * 10) / 10 : null,
      },
      members: invites.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        image: row.image,
        status: row.status,
        assignedAt: row.assignedAt.toISOString(),
      })),
      sessions: sessions.slice(0, 20),
    };
  }),
});

/** A role play's Before settings (Settings tab), as the builder saves them. */
const beforeInput = z.object({
  preScreenshare: z.boolean(),
  preUpload: z.boolean(),
  preUploadRequired: z.boolean().optional(),
  duringUpload: z.boolean(),
  uploadTitle: z.string().trim().max(80),
  uploadInstruction: z.string().trim().max(300),
}).strict();

const builderRouter = t.router({
  /** The builder's fields and Before settings of a role play, for editing. */
  get: studioProcedure.input(slugInput).query(async ({ ctx, input }) => {
    const agent = await findRoleplay(ctx.user.orgId, input.slug);
    const brief = briefOf(agent.data);
    const builder = roleplayBuilderFrom(agent.data);
    return {
      slug: agent.slug,
      builder: builder ? { ...builder, persona: agent.persona.slug } : null,
      before: beforeSettings(agent.data),
      tools: toolSettings(agent.data),
      // A role play the copilot wrote: its core fields (editable here) and its script (changed through the copilot).
      brief: brief ? {
        kind: "brief" as const,
        persona: agent.persona.slug,
        title: brief.title,
        learnerBrief: brief.learnerBrief,
        aiStarts: brief.start.who === "ai",
        openingLine: brief.start.openingLine ?? "",
        limit: brief.ending.limit ?? "",
        script: scriptOf(brief),
      } : builder ? {
        // Made in the older form: the same simple page (no time limit; its script is changed through the copilot).
        kind: "builder" as const,
        persona: agent.persona.slug,
        title: builder.name,
        learnerBrief: builder.whatToExpect ?? "",
        aiStarts: true,
        openingLine: builder.opening ?? "",
        limit: "",
        script: builderScriptOf(builder),
      } : {
        // An authored skill (a ported interview): name and persona here; the skill is changed through the copilot.
        kind: "authored" as const,
        persona: agent.persona.slug,
        title: agent.name,
        learnerBrief: text(asRecord(agent.data).learnerBrief) ?? "",
        aiStarts: true,
        openingLine: "",
        limit: "",
        script: authoredScriptOf(agent.data),
      },
    };
  }),

  /**
   * Saves the core fields of a role play the copilot wrote (name, persona, learner brief, opening line, time limit) by
   * republishing its brief: the script is re-rendered and a real change is a new version. The rest of the script is
   * changed through the copilot.
   */
  saveBrief: studioProcedure
    .input(slugInput.extend({
      persona: z.string().trim().min(1).max(200).optional(),
      title: z.string().trim().min(1).max(120),
      learnerBrief: z.string().trim().max(1000),
      openingLine: z.string().trim().max(400),
      limit: z.string().trim().max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const agent = await findRoleplay(ctx.user.orgId, input.slug);
      const brief = briefOf(agent.data);
      if (!brief && !roleplayBuilderFrom(agent.data)) {
        // An authored skill: its name, persona and learner brief are edited here; the skill through the copilot.
        let changed = false;
        await withLock([ownershipLock(ctx.user.orgId), `agent:${agent.slug}`], async (tx) => {
          const current = await tx.agent.findFirst({ where: { id: agent.id, archivedAt: null }, select: { name: true, personaId: true, data: true, primarySkillId: true } });
          if (!current) throw refusals.notFound();
          const persona = input.persona && await tx.persona.findFirst({ where: { orgId: ctx.user.orgId, slug: { equals: input.persona, mode: "insensitive" } }, select: { id: true } });
          if (input.persona && !persona) throw new TRPCError({ code: "NOT_FOUND", message: `Persona "${input.persona}" was not found in this organization` });
          const personaId = persona ? persona.id : current.personaId;
          const data = (current.data && typeof current.data === "object" ? current.data : {}) as Record<string, unknown>;
          const managed = current.primarySkillId && (await skillOwnership(ctx.user.orgId, tx)).mode === "managed";
          changed = input.title !== current.name || personaId !== current.personaId || (text(data.learnerBrief) ?? "") !== input.learnerBrief;
          if (!changed) return;
          const stored = managed ? packageFieldsOmitted(data) : data;
          const rest = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "learnerBrief"));
          await tx.agent.update({
            where: { id: agent.id },
            data: { name: input.title, personaId, data: { ...rest, name: input.title, ...(input.learnerBrief ? { learnerBrief: input.learnerBrief } : {}) } as Prisma.InputJsonValue },
          });
        });
        return { slug: agent.slug, version: agent.version, changed };
      }
      if (!input.learnerBrief) throw new TRPCError({ code: "BAD_REQUEST", message: "Write the learner brief" });
      if (!brief) {
        // Made in the older form: the same basics, saved through its builder fields.
        if (!roleplayBuilderFrom(agent.data)) throw new TRPCError({ code: "BAD_REQUEST", message: "This role play can't be edited here" });
        try {
          const saved = await updateRoleplay(ctx.user.orgId, agent.slug, { builder: { name: input.title, ...(input.persona ? { persona: input.persona } : {}), whatToExpect: input.learnerBrief, opening: input.openingLine } });
          return { slug: saved.slug, version: "version" in saved ? saved.version ?? agent.version : agent.version, changed: "version" in saved && saved.version !== agent.version };
        } catch (error) {
          if (error instanceof ScenarioIngestError) throw new TRPCError({ code: error.status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: error.message });
          throw error;
        }
      }
      const next: RoleplayBrief = {
        ...brief,
        title: input.title,
        learnerBrief: input.learnerBrief,
        start: { ...brief.start, openingLine: input.openingLine || undefined },
        ending: { ...brief.ending, limit: input.limit || undefined },
      };
      try {
        const saved = await publishRoleplayBrief(ctx.user.orgId, { personaSlug: input.persona ?? agent.persona.slug, brief: next });
        if (saved.slug !== agent.slug) throw new TRPCError({ code: "CONFLICT", message: "The role play's id changed; edit it through the copilot" });
        return { slug: saved.slug, version: saved.version, changed: saved.version !== agent.version };
      } catch (error) {
        if (error instanceof ScenarioIngestError) {
          throw new TRPCError({ code: error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),

  /** Each new session picks one of the active personas at random (specs/agents.md). */
  personaPool: studioProcedure.input(slugInput).query(async ({ ctx, input }) => {
    const agent = await findRoleplay(ctx.user.orgId, input.slug);
    const rows = await db.agentPersona.findMany({
      where: { agentId: agent.id, active: true }, orderBy: { position: "asc" },
      select: { persona: { select: { slug: true } } },
    });
    return rows.map((row) => row.persona.slug);
  }),
  setPersonaPool: studioProcedure
    .input(slugInput.extend({ personas: z.array(z.string().trim().min(1).max(200)).min(1).max(21) }))
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.user.orgId;
      const slugs = [...new Set(input.personas)];
      await withLock([`agent:${input.slug}`], async (tx) => {
        const agent = await tx.agent.findFirst({ where: { ...roleplaysOf(orgId), slug: input.slug, archivedAt: null }, select: { id: true, personaId: true } });
        if (!agent) throw refusals.notFound();
        const personas = await tx.persona.findMany({ where: { orgId, slug: { in: slugs } }, select: { id: true, slug: true } });
        const idOf = new Map(personas.map((row) => [row.slug, row.id]));
        const missing = slugs.find((slug) => !idOf.has(slug));
        if (missing) throw new TRPCError({ code: "NOT_FOUND", message: `Persona "${missing}" was not found in this organization` });
        const ids = slugs.map((slug) => idOf.get(slug)!);
        if (ids.includes(agent.personaId)) {
          ids.splice(ids.indexOf(agent.personaId), 1);
          ids.unshift(agent.personaId);
        }
        await setAgentPersonas(agent.id, ids.map((personaId) => ({ personaId, active: true })), tx);
      });
      return { ok: true };
    }),

  /** The org's personas the client can be (Persona Library), with photo and role. */
  personas: studioProcedure.query(async ({ ctx }) =>
    (await listPersonas(ctx.user.orgId)).map((row) => ({
      slug: row.slug,
      name: row.persona.name,
      role: row.persona.role,
      isOwn: row.isOwn,
      photoUrl: row.photoUrl,
    })),
  ),

  /** Creates (no slug) or updates a role play: Before + During (rendered into SKILL.md / items) + After. */
  save: studioProcedure
    .input(z.object({
      slug: z.string().min(1).max(200).optional(),
      builder: roleplayBuilderSchema,
      before: beforeInput,
      tools: toolSettingsInput,
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.slug) await findRoleplay(ctx.user.orgId, input.slug);
      try {
        const saved = await saveRoleplay(ctx.user.orgId, input.builder, input.slug, input.before, input.tools);
        return { slug: saved.slug, version: saved.version, created: saved.created };
      } catch (error) {
        if (error instanceof ScenarioIngestError) {
          throw new TRPCError({ code: error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),

  /**
   * Saves an existing role play's Settings and Tools tabs as they change (switches on flip, the upload card with its
   * own Save). Only Agent.data.before / .tools: the script isn't re-rendered, so no new version. A running call keeps
   * the settings it started with.
   */
  saveSettings: studioProcedure
    .input(slugInput.extend({ before: beforeInput.optional(), tools: toolSettingsInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await findRoleplay(ctx.user.orgId, input.slug);
      // Under the role play's save lock, reading its data again (specs/practice.md rule 20): a builder save that just
      // landed isn't undone, and the version doesn't move.
      await withLock([ownershipLock(ctx.user.orgId), `agent:${agent.slug}`], async (tx) => {
        const current = await tx.agent.findFirst({ where: { id: agent.id, archivedAt: null }, select: { data: true, primarySkillId: true } });
        if (!current) throw refusals.notFound();
        const data = (current.data && typeof current.data === "object" ? current.data : {}) as Record<string, unknown>;
        const managed = current.primarySkillId && (await skillOwnership(ctx.user.orgId, tx)).mode === "managed";
        await tx.agent.update({
          where: { id: agent.id },
          data: { data: { ...(managed ? packageFieldsOmitted(data) : data), ...(input.before ? { before: input.before } : {}), ...(input.tools ? { tools: input.tools } : {}) } as Prisma.InputJsonValue },
        });
      });
      return { ok: true };
    }),
});

const sessionsRouter = t.router({
  /** Practice sessions on the org's role plays, newest first. */
  list: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const [rows, builder] = await Promise.all([
      db.interviewSession.findMany({ where: anyRoleplaySessions(orgId), orderBy: { startedAt: "desc" }, take: 200, select: sessionSelect }),
      db.agent.findMany({ where: roleplaysOf(orgId), select: { id: true } }),
    ]);
    const builderIds = new Set(builder.map((agent) => agent.id));
    // A session run by the legacy interview runtime (before its role play was converted) keeps its interview report page.
    return rows.map((row) => ({ ...sessionItem(row), ...(builderIds.has(row.agentId) && !legacyReport(row.report) ? {} : { href: dashRoute(`/sessions/${row.id}`) }) }));
  }),

  /** One session: learner, client, report (goals, rubric, notes) and transcript. */
  get: studioProcedure.input(z.object({ id: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    const row = await db.interviewSession.findFirst({
      where: roleplaySessions(ctx.user.orgId, { id: input.id }),
      select: { ...sessionSelect, transcript: true, compiledSnapshot: true, skillPinsVersion: true, agent: { select: { id: true, slug: true, version: true, primarySkillId: true, name: true, data: true, persona: { select: personaSelect } } } },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    const snapshot = asRecord(row.compiledSnapshot);
    const savedData = asRecord(snapshot.agent).data;
    if (row.skillPinsVersion != null && !savedData) throw skillRefusals.unavailable();
    const current = !savedData && row.agent.primarySkillId
      ? await hydrateAgentSkill(ctx.user.orgId, row.agent)
      : row.agent;
    const savedPersona = asRecord(snapshot.persona).data;
    return {
      ...sessionItem(row),
      client: clientOf(savedPersona ? { ...row.agent.persona, data: savedPersona as Prisma.JsonValue } : row.agent.persona, savedData ?? current.data),
      report: roleplayReport(row.report),
      turns: transcriptTurns(row.transcript).map((turn) => ({ who: turn.who === "learner" ? ("learner" as const) : ("client" as const), text: turn.text })),
    };
  }),

  /** Report state only, for quiet polling while a report is being made. */
  reportState: studioProcedure.input(z.object({ id: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    const row = await db.interviewSession.findFirst({
      where: roleplaySessions(ctx.user.orgId, { id: input.id }),
      select: { status: true, reportStatus: true, report: true, endedAt: true },
    });
    return { state: row ? reportState(row) : ("unavailable" as const) };
  }),
});

const usersRouter = t.router({
  /** The org's learners (role user), for the assign dialog. */
  orgLearners: studioProcedure.query(({ ctx }) => assignablePeople(ctx.user.orgId)),

  /** The org's people practising its role plays (given one, or with sessions): how many role plays, how many sessions. */
  list: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const agents = await db.agent.findMany({ where: anyRoleplayOf(orgId), select: { id: true } });
    const [members, invites, sessions] = await Promise.all([
      orgPeople(orgId, { includeDisabled: true }),
      invitesFor(orgId, agents.map((agent) => agent.id)),
      db.interviewSession.findMany({ where: anyRoleplaySessions(orgId), select: { agentId: true, userId: true } }),
    ]);
    const byUser = new Map(members.map((member) => [member.userId, member]));
    const byMember = new Map(members.map((member) => [member.memberId, member]));
    const people = new Map<string, { name: string; email: string; image: string | null; roleplays: Set<string>; sessions: number }>();
    const person = (member: (typeof members)[number]) => {
      const found = people.get(member.userId) ?? { name: member.name, email: member.email, image: member.image, roleplays: new Set<string>(), sessions: 0 };
      people.set(member.userId, found);
      return found;
    };
    for (const row of invites) {
      const member = byMember.get(row.memberId);
      if (member) person(member).roleplays.add(row.agentId);
    }
    for (const row of sessions) {
      if (!row.userId) continue;
      const member = byUser.get(row.userId);
      if (!member) continue;
      const found = person(member);
      found.roleplays.add(row.agentId);
      found.sessions += 1;
    }
    const credits = await creditsLeftFor(orgId, [...people.values()].map((row) => row.email));
    return [...people.entries()]
      // creditsLeft: their practice minutes left (shared with twins); null for admin and team.
      .map(([userId, { roleplays, ...rest }]) => ({ ...rest, userId, roleplays: roleplays.size, creditsLeft: credits.get(rest.email)?.left ?? null }))
      .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  }),
});

export const roleplayRouter = t.router({
  scenarios: scenariosRouter,
  builder: builderRouter,
  sessions: sessionsRouter,
  users: usersRouter,
});

export type RoleplayRouter = typeof roleplayRouter;
export type RoleplayOutputs = import("@trpc/server").inferRouterOutputs<RoleplayRouter>;
