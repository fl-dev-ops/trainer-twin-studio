import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { builtFrom } from "@/lib/skill-sources";
import type { Prisma } from "@/lib/generated/prisma/client";
import { beforeSettings } from "@/lib/context-upload";
import { assignablePeople } from "@/lib/learners";
import { LEARNER_ROLE } from "@/lib/org";
import { LEARNER, orgPeople, orgPerson } from "@/lib/org-people";
import { AppError, refusals } from "@/lib/errors";
import { learnerMinutes, MAX_LEARNER_MINUTES } from "@/lib/minutes";
import { studioProcedure, t } from "@/lib/trpc";
import { runTwinAssign } from "@/lib/workflow-runs";
import {
  accessUntilSchema,
  findTwinAgent,
  listTwinAssignments,
  twinSharePath,
  twinShareUrl,
} from "@/lib/twin-access";
import { TWIN_SOURCE } from "@/lib/twins";
import { HEADSHOT_STYLES } from "@/lib/headshot";
import { AVATAR_VIDEO_TYPES, AvatarError, avatarPhotoUrl, avatarState, avatarVideoUpload, makeHeadshot, saveAvatar, savePersonaVoice, type AvatarVideoType } from "@/lib/twin/avatar";
import { getRun } from "workflow/api";
import { isTwinReport, reportState } from "@/lib/twin/session-report";
import { stripAttachments } from "@/lib/markers";
import { rawScore, type CalibrationScore } from "@/lib/twin/calibration-score";
import { sessionEvidence } from "@/lib/twin/evidence";
import { updateTwin } from "@/lib/twin/manage";
import { attachRatings, durationSeconds, firstExchange, lastSevenDays, likeRateByWeek, mostAsked, titleFrom, transcriptTurns } from "@/lib/twin/stats";

/**
 * Twin-scoped tRPC surface, mounted at /api/twin. Studio members (admin, team) only; every query is
 * scoped to their organization. Server components call it through `twinRouter.createCaller`.
 */

const slugInput = z.object({ slug: z.string().min(1).max(200) });
const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Avatar errors as tRPC errors (our refusals, AppError, are handled for every procedure in lib/trpc.ts). */
async function twinCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AvatarError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    throw error;
  }
}

/**
 * Learner conversations with twins: calibrations, failed starts, and sessions run by studio members
 * (admin/team trying the twin) are not part of them.
 */
const learnerSessions = (orgId: string, agentId?: string): Prisma.InterviewSessionWhereInput => ({
  orgId,
  deletedAt: null,
  startedAt: { not: null },
  status: { not: "failed" },
  twinCalibration: { is: null },
  agent: { kind: "TWIN" },
  user: { members: { some: { organizationId: orgId, role: LEARNER_ROLE } } },
  ...(agentId ? { agentId } : {}),
});

const sessionRowSelect = {
  id: true,
  createdAt: true,
  startedAt: true,
  endedAt: true,
  status: true,
  reportStatus: true,
  feedbackRating: true,
  transcript: true,
  agent: { select: { slug: true, name: true } },
  user: { select: { id: true, name: true, email: true, image: true } },
  report: true,
} as const;

type SessionRow = Prisma.InterviewSessionGetPayload<{ select: typeof sessionRowSelect }>;

/** One row of a twin sessions list. */
function sessionItem(row: SessionRow) {
  const { question, answer } = firstExchange(transcriptTurns(row.transcript));
  return {
    id: row.id,
    learner: row.user.name || row.user.email,
    learnerEmail: row.user.email,
    agentSlug: row.agent.slug,
    agentName: row.agent.name,
    at: (row.startedAt ?? row.createdAt).toISOString(),
    seconds: durationSeconds(row.startedAt, row.endedAt),
    /** Learner questions the report counted (0 until the report is ready). */
    questionsCount: isTwinReport(row.report) ? row.report.questions.length : 0,
    /** Topics discussed, from the after-call report (empty until it's ready). */
    topics: isTwinReport(row.report) ? row.report.topics : [],
    question,
    answer,
    rating: row.feedbackRating,
  };
}

/**
 * Each active learner's use of one twin: minutes, sessions, last active and mean "Helpful" rating, most recently
 * active first (never started last). shortcut: counts come from the page's latest 200 sessions; a learner with
 * older sessions shows fewer, upgrade to a grouped query if twins get that busy.
 */
export function learnerActivity(
  assignments: { email: string; minutesGiven: number; minutesUsed: number; accessUntil: Date | null; user: { id: string; name: string | null; image: string | null } }[],
  sessions: SessionRow[],
) {
  return assignments
    .map((row) => {
      const mine = sessions.filter((session) => session.user.id === row.user.id);
      const rated = mine.map((session) => session.feedbackRating).filter((r): r is number => r !== null);
      return {
        email: row.email,
        userId: row.user.id,
        name: row.user.name || row.email,
        image: row.user.image,
        /** The learner's minutes (given / used), shared with every twin and role play they have. */
        minutes: row.minutesGiven,
        used: row.minutesUsed,
        until: row.accessUntil?.toISOString() ?? null,
        sessions: mine.length,
        // Sessions arrive newest first.
        lastAt: mine[0] ? (mine[0].startedAt ?? mine[0].createdAt).toISOString() : null,
        helpScore: rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : null,
      };
    })
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

/** Calibrations of one twin, newest first, with their rating counts. */
async function calibrationRows(orgId: string, agentId: string) {
  const rows = await db.twinCalibration.findMany({
    where: { session: { orgId, agentId, deletedAt: null } },
    orderBy: { createdAt: "desc" },
    take: 100, // the newest (specs/practice.md rule 15)
    select: {
      id: true,
      createdAt: true,
      turns: true,
      offTurns: true,
      session: { select: { startedAt: true, endedAt: true, transcript: true } },
      ratings: { select: { turnIndex: true, reply: true, rating: true, question: true, createdAt: true } },
    },
  });
  return rows.map((row) => {
    const turns = transcriptTurns(row.session.transcript);
    return {
      id: row.id,
      title: titleFrom(turns.find((turn) => turn.who === "learner")?.text ?? row.ratings[0]?.question, "Calibration"),
      at: (row.session.startedAt ?? row.createdAt).toISOString(),
      seconds: durationSeconds(row.session.startedAt, row.session.endedAt),
      ...savedScore(row, turns),
      ratings: row.ratings,
    };
  });
}

/** Jev's saved turns / meant "Feels off" for a calibration; the raw counts until it has been scored. */
function savedScore(
  row: { turns: number | null; offTurns: number | null; ratings: { turnIndex: number; question: string | null; reply: string; rating: string }[] },
  turns: ReturnType<typeof transcriptTurns>,
): CalibrationScore {
  if (row.turns !== null && row.offTurns !== null) return { turns: row.turns, off: row.offTurns };
  return rawScore(attachRatings(turns, row.ratings));
}

/** A calibration row for the client: rating details stay on the server. */
function omitRatings<T extends { ratings: unknown }>(row: T): Omit<T, "ratings"> {
  const { ratings, ...rest } = row;
  void ratings;
  return rest;
}

/** Persona-level label of who talks to the twin ("Agent", "Learner"...), from the skill's scenario.json. */
const whoAsks = (data: Record<string, unknown>) => text(asRecord(data.scenario).learner_role) ?? "Learner";

/** A twin is the org admin's own AI: their avatar stands in when no AI avatar is configured. */
async function orgAdmin(orgId: string) {
  const [admin] = await orgPeople(orgId, { roles: ["admin"], includeDisabled: true });
  return admin ? { name: admin.name, email: admin.email, image: admin.image } : null;
}

/** The twin's face: its persona's avatar photo (Avatar row), served through the same-site avatar route. */
const personaFace = { select: { slug: true, avatar: { select: { s3ImageKey: true, updatedAt: true } } } } as const;
const aiAvatarUrl = (persona: { slug: string; avatar: { s3ImageKey: string | null; updatedAt: Date } | null }) =>
  avatarPhotoUrl(persona.slug, persona.avatar);

const agentsRouter = t.router({
  /** The library: all-skills twins and skill twins, with assigned learners and the latest learner question. */
  list: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const [agents, assignments, latest, admin] = await Promise.all([
      db.agent.findMany({
        where: { orgId, kind: "TWIN", archivedAt: null },
        orderBy: [{ order: "asc" }, { name: "asc" }],
        select: { id: true, slug: true, name: true, data: true, updatedAt: true, persona: personaFace },
      }),
      db.twinAssignment.findMany({
        where: { orgId, status: "active" },
        orderBy: { createdAt: "asc" },
        select: { agentId: true, user: { select: { name: true, email: true, image: true } } },
      }),
      db.interviewSession.findMany({
        where: learnerSessions(orgId),
        orderBy: { createdAt: "desc" },
        distinct: ["agentId"],
        select: { agentId: true, transcript: true },
      }),
      orgAdmin(orgId),
    ]);
    const questionOf = new Map(latest.map((row) => [row.agentId, firstExchange(transcriptTurns(row.transcript)).question]));
    const cards = agents.map((agent) => {
      const data = asRecord(agent.data);
      return {
        slug: agent.slug,
        name: agent.name,
        description: text(data.objective),
        quote: questionOf.get(agent.id) ?? null,
        updatedAt: agent.updatedAt.toISOString(),
        allSkills: data.source === TWIN_SOURCE,
        face: { person: admin, avatarUrl: aiAvatarUrl(agent.persona) },
        learners: assignments
          .filter((row) => row.agentId === agent.id)
          .map((row) => ({ name: row.user.name || row.user.email, email: row.user.email.toLowerCase(), image: row.user.image })),
      };
    });
    return { twins: cards.filter((card) => card.allSkills), skills: cards.filter((card) => !card.allSkills) };
  }),

  /** One twin's page: description, minutes credit, report numbers, calibrations, learner sessions and learners. */
  get: studioProcedure.input(slugInput).query(({ ctx, input }) => twinCall(async () => {
    const orgId = ctx.user.orgId;
    const found = await findTwinAgent(orgId, input.slug);
    const [agent, assignments, sessions, calibrations, skillAgents] = await Promise.all([
      db.agent.findUniqueOrThrow({ where: { id: found.id }, select: { data: true, version: true } }),
      listTwinAssignments(orgId, found.id),
      db.interviewSession.findMany({
        where: learnerSessions(orgId, found.id),
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { ...sessionRowSelect, report: true },
      }),
      calibrationRows(orgId, found.id),
      // The org's skill twins: what the main (all-skills) twin's page lists in place of its description.
      db.agent.findMany({
        where: { orgId, kind: "TWIN", archivedAt: null, NOT: { data: { path: ["source"], equals: TWIN_SOURCE } } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, slug: true, name: true, version: true },
      }),
    ]);
    const data = asRecord(agent.data);
    const allSkills = data.source === TWIN_SOURCE;
    const active = assignments.filter((row) => row.status === "active");
    const lengths = sessions.map((row) => durationSeconds(row.startedAt, row.endedAt)).filter((s): s is number => s !== null);
    const rated = sessions.map((row) => row.feedbackRating).filter((r): r is number => r !== null);
    return {
      slug: found.slug,
      name: found.name,
      description: text(data.objective),
      whoAsks: whoAsks(data),
      allSkills,
      /** The twin agents the main twin covers (empty for a skill twin). */
      skills: allSkills ? skillAgents.map(({ slug, name }) => ({ slug, name })) : [],
      /**
       * The knowledge base documents this skill's live version was built from (the main twin: all its live skills'),
       * with items per document; null when not recorded (skills from before the knowledge base sync).
       */
      builtFrom: await builtFrom(orgId, allSkills
        ? skillAgents.map((skill) => ({ agentId: skill.id, version: skill.version }))
        : [{ agentId: found.id, version: agent.version }]),
      settings: beforeSettings(data),
      credit: {
        // Minutes of this twin's learners (each learner's own, shared with their other twins and role plays).
        minutes: active.reduce((sum, row) => sum + row.minutesGiven, 0),
        used: Math.round(active.reduce((sum, row) => sum + row.minutesUsed, 0)),
      },
      report: {
        sessions: sessions.length,
        helpScore: rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : null,
        avgMinutes: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length / 6) / 10 : null,
        week: lastSevenDays(sessions.map((row) => row.startedAt ?? row.createdAt)),
        feelsLikeMe: likeRateByWeek(calibrations.flatMap((row) => row.ratings.map((rating) => ({ rating: rating.rating, at: rating.createdAt })))),
        mostAsked: mostAsked(sessions.map((row) => (isTwinReport(row.report) ? row.report.questions : []))),
        /** What learners asked that the twin declined ("please ask the real …"), counted like mostAsked. */
        couldntAnswer: mostAsked(sessions.map((row) => (isTwinReport(row.report) ? row.report.unanswered ?? [] : []))),
        pendingReports: sessions.filter((row) => reportState(row) === "pending").length,
      },
      calibrations: calibrations.map((row) => omitRatings(row)),
      sessions: sessions.map(sessionItem),
      learners: learnerActivity(active, sessions),
    };
  })),

  /** How many of this twin's learner sessions are still getting their report (the page polls while > 0). */
  pendingReports: studioProcedure.input(slugInput).query(({ ctx, input }) => twinCall(async () => {
    const found = await findTwinAgent(ctx.user.orgId, input.slug);
    const rows = await db.interviewSession.findMany({
      where: {
        ...learnerSessions(ctx.user.orgId, found.id),
        OR: [{ reportStatus: "generating" }, { reportStatus: { in: ["none"] } }, { reportStatus: null }],
      },
      take: 200,
      select: { status: true, reportStatus: true, report: true, endedAt: true },
    });
    return { count: rows.filter((row) => reportState(row) === "pending").length };
  })),

  /** Name, description and conversation settings. Saved like any spec change: snapshot, then version + 1. */
  update: studioProcedure
    .input(slugInput.extend({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(2000),
      settings: z.object({
        preScreenshare: z.boolean(),
        preUpload: z.boolean(),
        duringUpload: z.boolean(),
        uploadTitle: z.string().trim().max(80),
        uploadInstruction: z.string().trim().max(300),
      }).strict(),
    }))
    .mutation(({ ctx, input }) => twinCall(async () => {
      const { version } = await updateTwin(ctx.user.orgId, input.slug, { name: input.name, description: input.description, settings: input.settings });
      return { version };
    })),

  /**
   * The twin's readable link (/t/<username> or /t/<short slug>). Creates nothing: the link only opens for people in
   * the org with an active assignment on this twin (their own minutes), so sharing it grants no access.
   */
  shareLink: studioProcedure.input(slugInput).mutation(({ ctx, input }) => twinCall(async () => {
    const found = await findTwinAgent(ctx.user.orgId, input.slug);
    const path = await twinSharePath(ctx.user.orgId, ctx.user.orgSlug, found.id);
    return { url: twinShareUrl(ctx.user.orgSlug, path) };
  })),
});

const assignmentsRouter = t.router({
  /** Who has the twin, and the org's learners who could get it. */
  list: studioProcedure.input(slugInput).query(({ ctx, input }) => twinCall(async () => {
    const found = await findTwinAgent(ctx.user.orgId, input.slug);
    const [assigned, assignable] = await Promise.all([listTwinAssignments(ctx.user.orgId, found.id), assignablePeople(ctx.user.orgId)]);
    const byUser = new Map(assigned.map((row) => [row.user.id, row]));
    // The org's learners (assignments always belong to one of them).
    return assignable
      .map((person) => {
        const row = byUser.get(person.userId);
        return {
          ...person,
          assigned: row?.status === "active",
          minutes: row ? row.minutesGiven : null,
          minutesUsed: row?.minutesUsed ?? 0,
          until: row?.accessUntil?.toISOString() ?? null,
        };
      })
      .sort((a, b) => Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name));
  })),

  /** Gives people the twin (new people get their starting minutes from the org balance) and emails them their link. */
  assign: studioProcedure
    .input(slugInput.extend({
      emails: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(100),
      accessUntil: accessUntilSchema,
      /** Credits each new person starts with; people who already have credits keep theirs. */
      startingMinutes: z.number().int().min(1).max(MAX_LEARNER_MINUTES).optional(),
    }))
    .mutation(({ ctx, input }) => twinCall(async () => {
      const agent = await findTwinAgent(ctx.user.orgId, input.slug);
      return runTwinAssign({
        org: { id: ctx.user.orgId, slug: ctx.user.orgSlug },
        by: { id: ctx.user.id, name: ctx.user.name },
        agent,
        emails: input.emails,
        accessUntil: input.accessUntil,
        startingMinutes: input.startingMinutes,
      });
    })),
});

const sessionsRouter = t.router({
  /** Learner conversations with every twin of the org, newest first. */
  list: studioProcedure.query(async ({ ctx }) => {
    const rows = await db.interviewSession.findMany({
      where: learnerSessions(ctx.user.orgId),
      orderBy: { createdAt: "desc" },
      take: 200,
      select: sessionRowSelect,
    });
    return rows.map(sessionItem);
  }),

  /** Report state only (cheap): polled by the session page while the report is being made. */
  reportState: studioProcedure
    .input(z.object({ id: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }) => ({ state: await sessionReportState(ctx.user.orgId, input.id) })),

  /** One learner conversation: transcript, feedback, topics. */
  get: studioProcedure.input(z.object({ id: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    const row = await db.interviewSession.findFirst({
      where: { ...learnerSessions(ctx.user.orgId), id: input.id },
      select: { ...sessionRowSelect, feedbackNote: true, report: true, evidence: true },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    return {
      ...sessionItem(row),
      feedbackNote: row.feedbackNote,
      topics: isTwinReport(row.report) ? row.report.topics : [],
      /** The questions the twin declined in this session. */
      unanswered: isTwinReport(row.report) ? row.report.unanswered ?? [] : [],
      reportState: reportState(row),
      hasVideo: typeof asRecord(row.evidence).videoS3Key === "string",
      turns: await withTurnAttachments(ctx.user.orgId, transcriptTurns(row.transcript)),
    };
  }),
});

/** One attachment a mid-call "[ATTACHED <id>]" marker resolved to: what the transcript-attachment card needs to render. */
export type TurnAttachment = { id: string; name: string; mediaType: string | null; href: string };

/**
 * Strips attachment markers out of transcript turns and resolves each referenced file in the org (one query for the
 * whole transcript). Unresolvable ids still render; they just have no kind or link.
 */
async function withTurnAttachments<T extends { text: string }>(orgId: string, turns: T[]): Promise<(T & { attached?: TurnAttachment[] })[]> {
  type Stripped = T & { strip: ReturnType<typeof stripAttachments> };
  const parsed: (T | Stripped)[] = turns.map((turn) =>
    turn.text.includes("[ATTACHED") ? { ...turn, strip: stripAttachments(turn.text) } : turn,
  );
  const ids = [...new Set(parsed.flatMap((turn) => ("strip" in turn ? turn.strip.files.map((file) => file.id) : [])))];
  if (!ids.length) return turns;
  const docs = await db.contextDocument.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, mimeType: true } });
  const types = new Map(docs.map((doc) => [doc.id, doc.mimeType]));
  return parsed.map((turn) =>
    "strip" in turn
      ? { ...turn, text: turn.strip.text, attached: turn.strip.files.map((file) => ({ id: file.id, name: file.name, mediaType: types.get(file.id) ?? null, href: `/api/uploads/${file.id}/view` })) }
      : turn,
  );
}

/**
 * A twin session's report state, for polling. A run that ended without saving (failed, cancelled, gone) is
 * marked failed here so the page stops waiting; nothing is restarted from a poll.
 */
async function sessionReportState(orgId: string, id: string) {
  const row = await db.interviewSession.findFirst({
    where: { ...learnerSessions(orgId), id },
    select: { status: true, reportStatus: true, report: true, endedAt: true, reportWorkflowRunId: true },
  });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  const state = reportState(row);
  if (state === "pending" && row.reportStatus === "generating" && row.reportWorkflowRunId) {
    const status = await getRun(row.reportWorkflowRunId).status.catch(() => null);
    if (status === "failed" || status === "cancelled") {
      await db.interviewSession.updateMany({ where: { id, reportStatus: "generating" }, data: { reportStatus: "failed" } });
      return "unavailable" as const;
    }
  }
  return state;
}


/** Of two end dates, the later; no end date (null) wins, since that access never ends. */
const laterEnd = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : null);

const usersRouter = t.router({
  /** The org's learners with twin access: how many twins, and their minutes (given and used, shared by twins and role plays). */
  list: studioProcedure.query(async ({ ctx }) => {
    const [learners, rows] = await Promise.all([
      orgPeople(ctx.user.orgId, { roles: [LEARNER] }),
      db.twinAssignment.findMany({ where: { orgId: ctx.user.orgId, status: "active" }, select: { userId: true, accessUntil: true } }),
    ]);
    const minutes = await learnerMinutes(ctx.user.orgId, learners.map((person) => person.email));
    // until: when this person's access ends; the latest of their twins, null when any twin has no end date.
    const people = new Map<string, { email: string; name: string; image: string | null; agents: number; minutes: number; used: number; until: Date | null }>();
    const learnerById = new Map(learners.map((person) => [person.userId, person]));
    for (const row of rows) {
      const learner = learnerById.get(row.userId);
      if (!learner) continue; // disabled
      const known = people.get(row.userId);
      const own = minutes.get(learner.email);
      const person = known
        ?? {
          email: learner.email, name: learner.name, image: learner.image, agents: 0,
          minutes: Math.floor((own?.grantedSeconds ?? 0) / 60), used: Math.round((own?.usedSeconds ?? 0) / 60), until: row.accessUntil,
        };
      if (known) person.until = laterEnd(person.until, row.accessUntil);
      person.agents += 1;
      people.set(row.userId, person);
    }
    return [...people.values()]
      .map((person) => ({ ...person, until: person.until?.toISOString() ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }),

  /** One learner across all twins: who they are and their twin sessions, newest first (the /users/<id> page). */
  get: studioProcedure.input(z.object({ id: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    const person = await orgPerson(ctx.user.orgId, { userId: input.id });
    if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    const user = { id: person.userId, name: person.name, email: person.email, image: person.image };
    const rows = await db.interviewSession.findMany({
      where: { ...learnerSessions(ctx.user.orgId), userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: sessionRowSelect,
    });
    return { user, sessions: rows.map(sessionItem) };
  }),
});

/** One calibration of this org that can still be seen: its call not deleted, its twin not archived (rule 15). */
const orgCalibration = (orgId: string, id: string) => ({ id, session: { orgId, deletedAt: null, agent: { archivedAt: null } } });

const calibrationsRouter = t.router({
  /** One twin's calibrations with their like/off counts. */
  list: studioProcedure.input(slugInput).query(({ ctx, input }) => twinCall(async () => {
    const found = await findTwinAgent(ctx.user.orgId, input.slug);
    const [rows, persona, admin] = await Promise.all([
      calibrationRows(ctx.user.orgId, found.id),
      db.agent.findUniqueOrThrow({ where: { id: found.id }, select: { persona: personaFace } }),
      orgAdmin(ctx.user.orgId),
    ]);
    return {
      name: found.name,
      face: { person: admin, avatarUrl: aiAvatarUrl(persona.persona) },
      calibrations: rows.map((row) => omitRatings(row)),
    };
  })),

  /** One calibration: the call's transcript with the ratings on the replies that were rated. */
  get: studioProcedure.input(z.object({ id: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    const row = await db.twinCalibration.findFirst({
      where: orgCalibration(ctx.user.orgId, input.id),
      select: {
        createdAt: true,
        turns: true,
        offTurns: true,
        sessionId: true,
        session: { select: { startedAt: true, transcript: true, agent: { select: { slug: true, name: true, persona: personaFace } } } },
        ratings: { orderBy: { turnIndex: "asc" }, select: { turnIndex: true, question: true, reply: true, rating: true } },
      },
    });
    if (!row) throw refusals.notFound();
    // The saved transcript usually comes from the voice agent, so ratings are matched to it by the reply they rated.
    const turns = await withTurnAttachments(
      ctx.user.orgId,
      attachRatings(transcriptTurns(row.session.transcript), row.ratings)
        .map((turn, i) => ({ id: String(i), speaker: turn.who === "twin" ? "twin" as const : "you" as const, text: turn.text, rating: turn.rating })),
    );
    return {
      score: savedScore(row, transcriptTurns(row.session.transcript)),
      slug: row.session.agent.slug,
      twinName: row.session.agent.name,
      photoUrl: aiAvatarUrl(row.session.agent.persona),
      startedAt: (row.session.startedAt ?? row.createdAt).toISOString(),
      sessionId: row.sessionId,
      turns,
    };
  }),

  /** "Why this answer" for a calibration call (or any of your twin calls): per twin reply, what it heard and looked up. */
  evidence: studioProcedure
    .input(z.object({ sessionId: z.string().min(1).max(100) }))
    .query(({ ctx, input }) => sessionEvidence(ctx.user.orgId, input.sessionId)),

  /** Rates one twin reply; rating the same turn again replaces it. */
  rate: studioProcedure
    .input(z.object({
      calibrationId: z.string().min(1).max(100),
      turnIndex: z.number().int().min(0).max(10_000),
      question: z.string().trim().max(8000).nullable(),
      reply: z.string().trim().min(1).max(8000),
      rating: z.enum(["like", "off"]),
    }))
    .mutation(async ({ ctx, input }) => {
      // The creator's own calibration, while its call is live (specs/practice.md rule 13).
      const calibration = await db.twinCalibration.findFirst({
        where: { ...orgCalibration(ctx.user.orgId, input.calibrationId), createdByUserId: ctx.user.id },
        select: { id: true, session: { select: { status: true } } },
      });
      if (!calibration) throw refusals.notFound();
      if (!["activating", "active"].includes(calibration.session.status)) {
        throw new AppError("calibration_ended", "This calibration call has ended.", 409);
      }
      const fields = { question: input.question || null, reply: input.reply, rating: input.rating };
      await db.twinCalibrationRating.upsert({
        where: { calibrationId_turnIndex: { calibrationId: calibration.id, turnIndex: input.turnIndex } },
        create: { calibrationId: calibration.id, turnIndex: input.turnIndex, ...fields },
        update: fields,
      });
      return { ok: true };
    }),
});

/** "Voice and avatar" on Twin's brain: photo (avatar), reference video, cloned voice. */
const avatarRouter = t.router({
  get: studioProcedure.query(({ ctx }) => avatarState(ctx.user.orgId)),
  /** Signed S3 upload for the reference video (too large to pass through the app). */
  videoUploadUrl: studioProcedure
    .input(z.object({ contentType: z.enum(Object.keys(AVATAR_VIDEO_TYPES) as [AvatarVideoType, ...AvatarVideoType[]]) }))
    .mutation(({ ctx, input }) => twinCall(() => avatarVideoUpload(ctx.user.orgId, input.contentType))),
  /** One AI version of the new photo (style 0..3); the page asks for each look in parallel. */
  headshot: studioProcedure
    .input(z.object({ photo: z.string().min(1).max(3_000_000), style: z.number().int().min(0).max(HEADSHOT_STYLES.length - 1) }))
    .mutation(({ ctx, input }) => twinCall(() => makeHeadshot(ctx.user.orgId, input))),
  save: studioProcedure
    .input(z.object({
      photo: z.string().min(1).max(3_000_000),
      /** The chosen AI version (a key from headshot); null keeps the photo as taken. */
      headshotKey: z.string().min(1).max(500).nullable().optional(),
    }))
    .mutation(({ ctx, input }) => twinCall(() => saveAvatar(ctx.user.orgId, input))),
  /** The on-camera take from /twin/brain/voice: its cloned voice becomes the persona's (every twin's), its video the avatar reference. */
  saveVoice: studioProcedure
    .input(z.object({ voiceId: z.string().min(1).max(100), videoKey: z.string().min(1).max(500) }))
    .mutation(({ ctx, input }) => twinCall(() => savePersonaVoice(ctx.user.orgId, input))),
});

export const twinRouter = t.router({
  /** Who is talking to us over /api/twin. */
  me: studioProcedure.query(({ ctx }) => ctx.user),
  agents: agentsRouter,
  assignments: assignmentsRouter,
  sessions: sessionsRouter,
  users: usersRouter,
  calibrations: calibrationsRouter,
  avatar: avatarRouter,
});

export type TwinRouter = typeof twinRouter;

/** What each twin query returns, for the page components. */
export type TwinOutputs = import("@trpc/server").inferRouterOutputs<TwinRouter>;
