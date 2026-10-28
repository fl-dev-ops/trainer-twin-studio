import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { beforeSettings } from "@/lib/context-upload";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { assignablePeople } from "@/lib/learners";
import { listPersonas } from "@/lib/personas";
import { isSessionReport } from "@/lib/session-report";
import { roleplayBuilderFrom, roleplayBuilderSchema } from "@/lib/roleplay/skill";
import { type RoleplayReport } from "@/lib/roleplay/session-report";
import { ROLEPLAY_SOURCE, saveRoleplay, ScenarioIngestError } from "@/lib/scenario-ingest";
import { agentDisplayName } from "@/lib/specs";
import { studioProcedure, t } from "@/lib/trpc";
import { avatarPhotoUrl } from "@/lib/twin/avatar";
import { durationSeconds, transcriptTurns } from "@/lib/twin/stats";

/**
 * Role-play tRPC surface, mounted at /api/roleplay (the twin module's twin, plans/roleplay-skill.md step 6).
 * Studio members only; every query is scoped to their organization. Covers role plays built in the builder
 * (source "roleplay-skill"); older interview role plays stay on /agents.
 */

const slugInput = z.object({ slug: z.string().min(1).max(200) });
const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Builder role plays of the org (detail, builder, assign and their session reports). */
const roleplaysOf = (orgId: string): Prisma.AgentWhereInput => ({ orgId, kind: "ROLEPLAY", data: { path: ["source"], equals: ROLEPLAY_SOURCE } });
/**
 * Every role play of the org, for the library, sessions and users lists: builder role plays plus the v1 interview
 * scenarios (no builder source), which keep opening their v1 pages (/agents/<slug>, /sessions/<id>).
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
    where: { ...roleplaysOf(orgId), slug },
    select: { id: true, slug: true, name: true, data: true, updatedAt: true, persona: { select: personaSelect } },
  });
  if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Role play not found" });
  return agent;
}

/** A finished role-play session's report, once made. */
const roleplayReport = (value: unknown): RoleplayReport | null =>
  isSessionReport(value) && asRecord(value).kind === "roleplay" ? (value as RoleplayReport) : null;

/** Where a session's report stands, for quiet polling (same states as twin). */
export type RoleplayReportState = "ready" | "pending" | "unavailable";
const JUST_ENDED_MS = 10 * 60_000;
function reportState(row: { status: string; reportStatus: string | null; report: unknown; endedAt: Date | null }, now = Date.now()): RoleplayReportState {
  if (roleplayReport(row.report)) return "ready";
  if (row.reportStatus === "generating") return "pending";
  const fresh = row.endedAt !== null && now - row.endedAt.getTime() < JUST_ENDED_MS;
  if (row.status === "completed" && (!row.reportStatus || row.reportStatus === "none") && fresh) return "pending";
  return "unavailable";
}

const sessionSelect = {
  id: true, agentId: true, status: true, reportStatus: true, report: true, startedAt: true, endedAt: true, createdAt: true,
  user: { select: { name: true, email: true, image: true } },
  agent: { select: { slug: true, name: true } },
} as const;
type SessionRow = Prisma.InterviewSessionGetPayload<{ select: typeof sessionSelect }>;

function sessionItem(row: SessionRow) {
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
    href: `/roleplay/sessions/${row.id}`,
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

/** People invited to a role play (RolePlayAssignment) and their status. */
async function invitesFor(orgId: string, agentIds: string[]) {
  return db.rolePlayAssignment.findMany({
    where: { orgId, deployment: { agentId: { in: agentIds } } },
    orderBy: { assignedAt: "desc" },
    select: {
      id: true, recipientEmail: true, status: true, assignedAt: true, expiresAt: true,
      deployment: { select: { agentId: true } },
      member: { select: { user: { select: { name: true, image: true } } } },
    },
  });
}

const scenariosRouter = t.router({
  /** The Scenarios library: one card per role play with its client, opening line and learners. */
  list: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const agents = await db.agent.findMany({
      where: anyRoleplayOf(orgId),
      orderBy: [{ order: "asc" }, { updatedAt: "desc" }],
      select: { id: true, slug: true, name: true, data: true, updatedAt: true, persona: { select: personaSelect } },
    });
    const ids = agents.map((agent) => agent.id);
    const [invites, sessions] = await Promise.all([
      invitesFor(orgId, ids),
      db.interviewSession.groupBy({ by: ["agentId"], where: { orgId, agentId: { in: ids }, deletedAt: null, startedAt: { not: null } }, _count: true }),
    ]);
    const sessionsOf = new Map(sessions.map((row) => [row.agentId, row._count]));
    return agents.map((agent) => {
      const data = asRecord(agent.data);
      const scenario = asRecord(data.scenario);
      // v1 interview scenarios: as in v1 (objective, opening, display name); they open their v1 page.
      const interview = data.source !== ROLEPLAY_SOURCE;
      return {
        slug: agent.slug,
        name: interview ? agentDisplayName(agent.slug, agent.name) : agent.name,
        interview,
        href: interview ? `/agents/${encodeURIComponent(agent.slug)}` : `/roleplay/${agent.slug}`,
        description: text(scenario.description) ?? (interview ? text(data.objective) : null),
        opening: text(asRecord(scenario.roleplay).opening) ?? (interview ? text(data.opening) : null),
        client: clientOf(agent.persona, agent.data),
        sessions: sessionsOf.get(agent.id) ?? 0,
        updatedAt: agent.updatedAt.toISOString(),
        learners: invites
          .filter((row) => row.deployment.agentId === agent.id)
          .map((row) => ({ name: row.member?.user.name || row.recipientEmail, email: row.recipientEmail, image: row.member?.user.image ?? null })),
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
    return {
      slug: agent.slug,
      name: agent.name,
      description: text(asRecord(asRecord(agent.data).scenario).description),
      situation: builder?.situation.scenario ?? null,
      learnerRole: builder?.situation.learnerRole ?? null,
      difficulty: builder?.difficulty ?? null,
      client: clientOf(agent.persona, agent.data),
      stats: {
        sessions: sessions.length,
        averageScore: scored.length ? Math.round(average(scored)!) : null,
        averageMinutes: lengths.length ? Math.round((average(lengths)! / 60) * 10) / 10 : null,
      },
      members: invites.map((row) => ({
        id: row.id,
        name: row.member?.user.name || row.recipientEmail,
        email: row.recipientEmail,
        image: row.member?.user.image ?? null,
        status: row.status === "pending" && row.expiresAt < new Date() ? "expired" : row.status,
        assignedAt: row.assignedAt.toISOString(),
      })),
      sessions: sessions.slice(0, 20),
    };
  }),
});

const builderRouter = t.router({
  /** The builder's fields and Before settings of a role play, for editing. */
  get: studioProcedure.input(slugInput).query(async ({ ctx, input }) => {
    const agent = await findRoleplay(ctx.user.orgId, input.slug);
    return { slug: agent.slug, builder: roleplayBuilderFrom(agent.data), before: beforeSettings(agent.data) };
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
      before: z.object({
        preScreenshare: z.boolean(),
        preUpload: z.boolean(),
        duringUpload: z.boolean(),
        uploadTitle: z.string().trim().max(80),
        uploadInstruction: z.string().trim().max(300),
      }).strict(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.slug) await findRoleplay(ctx.user.orgId, input.slug);
      try {
        const saved = await saveRoleplay(ctx.user.orgId, input.builder, input.slug, input.before);
        return { slug: saved.slug, version: saved.version, created: saved.created };
      } catch (error) {
        if (error instanceof ScenarioIngestError) {
          throw new TRPCError({ code: error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
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
    // A v1 interview session opens its v1 page, where its interview report shows.
    return rows.map((row) => ({ ...sessionItem(row), ...(builderIds.has(row.agentId) ? {} : { href: `/sessions/${row.id}` }) }));
  }),

  /** One session: learner, client, report (goals, rubric, notes) and transcript. */
  get: studioProcedure.input(z.object({ id: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    const row = await db.interviewSession.findFirst({
      where: roleplaySessions(ctx.user.orgId, { id: input.id }),
      select: { ...sessionSelect, transcript: true, agent: { select: { slug: true, name: true, data: true, persona: { select: personaSelect } } } },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    return {
      ...sessionItem(row),
      client: clientOf(row.agent.persona, row.agent.data),
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

  /** Everyone practising on the org's role plays: invited or with sessions, how many role plays, how many sessions. */
  list: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const agents = await db.agent.findMany({ where: anyRoleplayOf(orgId), select: { id: true } });
    const [invites, sessions] = await Promise.all([
      invitesFor(orgId, agents.map((agent) => agent.id)),
      db.interviewSession.findMany({ where: anyRoleplaySessions(orgId), select: { agentId: true, user: { select: { name: true, email: true, image: true } } } }),
    ]);
    const people = new Map<string, { name: string; email: string; image: string | null; roleplays: Set<string>; sessions: number }>();
    const person = (email: string, name: string, image: string | null) => {
      const key = email.toLowerCase();
      const found = people.get(key) ?? { name, email: key, image, roleplays: new Set<string>(), sessions: 0 };
      people.set(key, found);
      return found;
    };
    for (const row of invites) person(row.recipientEmail, row.member?.user.name || row.recipientEmail, row.member?.user.image ?? null).roleplays.add(row.deployment.agentId);
    for (const row of sessions) {
      const found = person(row.user.email, row.user.name || row.user.email, row.user.image);
      found.roleplays.add(row.agentId);
      found.sessions += 1;
    }
    return [...people.values()]
      .map(({ roleplays, ...rest }) => ({ ...rest, roleplays: roleplays.size }))
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
