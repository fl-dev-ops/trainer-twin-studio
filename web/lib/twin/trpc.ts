import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { beforeSettings } from "@/lib/context-upload";
import { LEARNER_ROLE } from "@/lib/org";
import { studioProcedure, t } from "@/lib/trpc";
import {
  assignTwinAndInvite,
  findTwinAgent,
  listTwinAssignments,
  TwinAccessError,
  twinSharePath,
  twinShareUrl,
} from "@/lib/twin-access";
import { TWIN_SOURCE } from "@/lib/twins";
import { HEADSHOT_STYLES } from "@/lib/headshot";
import { AVATAR_VIDEO_TYPES, AvatarError, avatarPhotoUrl, avatarState, avatarVideoUpload, makeHeadshot, saveAvatar, type AvatarVideoType } from "@/lib/twin/avatar";
import { getRun } from "workflow/api";
import { isTwinReport, reportState } from "@/lib/twin/session-report";
import { rawScore, scoreCalibration, type CalibrationScore } from "@/lib/twin/calibration-score";
import { attachRatings, durationSeconds, firstExchange, lastSevenDays, likeRateByWeek, mostAsked, titleFrom, transcriptTurns } from "@/lib/twin/stats";

/**
 * Twin-scoped tRPC surface, mounted at /api/twin. Studio members (admin, team) only; every query is
 * scoped to their organization. Server components call it through `twinRouter.createCaller`.
 */

const slugInput = z.object({ slug: z.string().min(1).max(200) });
const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** twin-access errors keep their meaning over tRPC. */
async function twinCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TwinAccessError) {
      throw new TRPCError({ code: error.status === 404 ? "NOT_FOUND" : error.status === 400 ? "BAD_REQUEST" : "FORBIDDEN", message: error.message });
    }
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
    question,
    answer,
    rating: row.feedbackRating,
  };
}

/** Calibrations of one twin, newest first, with their rating counts. */
async function calibrationRows(orgId: string, agentId: string) {
  const rows = await db.twinCalibration.findMany({
    where: { session: { orgId, agentId, deletedAt: null } },
    orderBy: { createdAt: "desc" },
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
  const admin = await db.member.findFirst({ where: { organizationId: orgId, role: "admin" }, select: { user: { select: { name: true, email: true, image: true } } } });
  return admin?.user ?? null;
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
        where: { orgId, kind: "TWIN" },
        orderBy: [{ order: "asc" }, { name: "asc" }],
        select: { id: true, slug: true, name: true, data: true, updatedAt: true, persona: personaFace },
      }),
      db.twinAssignment.findMany({
        where: { orgId, status: "active" },
        orderBy: { createdAt: "asc" },
        select: { agentId: true, recipientEmail: true, user: { select: { name: true, image: true } } },
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
          .map((row) => ({ name: row.user?.name || row.recipientEmail, email: row.recipientEmail, image: row.user?.image ?? null })),
      };
    });
    return { twins: cards.filter((card) => card.allSkills), skills: cards.filter((card) => !card.allSkills) };
  }),

  /** One twin's page: description, minutes credit, report numbers, calibrations and learner sessions. */
  get: studioProcedure.input(slugInput).query(({ ctx, input }) => twinCall(async () => {
    const orgId = ctx.user.orgId;
    const found = await findTwinAgent(orgId, input.slug);
    const [agent, assignments, sessions, calibrations] = await Promise.all([
      db.agent.findUniqueOrThrow({ where: { id: found.id }, select: { data: true } }),
      listTwinAssignments(orgId, found.id),
      db.interviewSession.findMany({
        where: learnerSessions(orgId, found.id),
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { ...sessionRowSelect, report: true },
      }),
      calibrationRows(orgId, found.id),
    ]);
    const data = asRecord(agent.data);
    const active = assignments.filter((row) => row.status === "active");
    const lengths = sessions.map((row) => durationSeconds(row.startedAt, row.endedAt)).filter((s): s is number => s !== null);
    const rated = sessions.map((row) => row.feedbackRating).filter((r): r is number => r !== null);
    return {
      slug: found.slug,
      name: found.name,
      description: text(data.objective),
      whoAsks: whoAsks(data),
      allSkills: data.source === TWIN_SOURCE,
      settings: beforeSettings(data),
      credit: {
        minutes: active.reduce((sum, row) => sum + row.minutesLimit, 0),
        used: Math.round(active.reduce((sum, row) => sum + row.minutesUsed, 0)),
      },
      report: {
        sessions: sessions.length,
        helpScore: rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : null,
        avgMinutes: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length / 6) / 10 : null,
        week: lastSevenDays(sessions.map((row) => row.startedAt ?? row.createdAt)),
        feelsLikeMe: likeRateByWeek(calibrations.flatMap((row) => row.ratings.map((rating) => ({ rating: rating.rating, at: rating.createdAt })))),
        mostAsked: mostAsked(sessions.map((row) => (isTwinReport(row.report) ? row.report.questions : []))),
        pendingReports: sessions.filter((row) => reportState(row) === "pending").length,
      },
      calibrations: calibrations.map((row) => omitRatings(row)),
      sessions: sessions.map(sessionItem),
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
      const found = await findTwinAgent(ctx.user.orgId, input.slug);
      const current = await db.agent.findUniqueOrThrow({ where: { id: found.id }, select: { version: true, data: true } });
      // Before settings: read by the session screen (lib/context-upload), enforced by session start and the attach
      // route. An older `twinSettings` key is left as is; `before` wins.
      const data = { ...asRecord(current.data), name: input.name, objective: input.description, before: input.settings };
      if (JSON.stringify(data) === JSON.stringify(current.data) && input.name === found.name) return { version: current.version };
      const json = (value: unknown) => value as Prisma.InputJsonValue;
      await db.$transaction([
        db.specVersion.create({ data: { entityType: "agents", entitySlug: found.slug, version: current.version, data: json(current.data), orgId: ctx.user.orgId } }),
        db.agent.update({ where: { id: found.id }, data: { name: input.name, version: current.version + 1, data: json(data) } }),
      ]);
      return { version: current.version + 1 };
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
    const [assigned, members] = await Promise.all([
      listTwinAssignments(ctx.user.orgId, found.id),
      db.member.findMany({
        where: { organizationId: ctx.user.orgId, role: LEARNER_ROLE },
        select: { user: { select: { name: true, email: true, image: true } } },
      }),
    ]);
    const byEmail = new Map(assigned.map((row) => [row.recipientEmail, row]));
    const people = new Map<string, { email: string; name: string; image: string | null }>();
    for (const { user } of members) people.set(user.email.toLowerCase(), { email: user.email.toLowerCase(), name: user.name || user.email, image: user.image });
    for (const row of assigned) {
      if (!people.has(row.recipientEmail)) people.set(row.recipientEmail, { email: row.recipientEmail, name: row.user?.name || row.recipientEmail, image: row.user?.image ?? null });
    }
    return [...people.values()]
      .map((person) => {
        const row = byEmail.get(person.email);
        return {
          ...person,
          assigned: row?.status === "active",
          minutes: row?.minutesLimit ?? null,
          minutesUsed: row?.minutesUsed ?? 0,
        };
      })
      .sort((a, b) => Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name));
  })),

  /** Gives people the twin with a minutes budget each and emails them their link. */
  assign: studioProcedure
    .input(slugInput.extend({
      emails: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(100),
      minutes: z.number().int().min(1).max(10_000),
    }))
    .mutation(({ ctx, input }) => twinCall(async () => {
      const agent = await findTwinAgent(ctx.user.orgId, input.slug);
      return assignTwinAndInvite({
        org: { id: ctx.user.orgId, slug: ctx.user.orgSlug },
        by: { id: ctx.user.id, name: ctx.user.name },
        agent,
        emails: input.emails,
        minutes: input.minutes,
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
      reportState: reportState(row),
      hasVideo: typeof asRecord(row.evidence).videoS3Key === "string",
      turns: transcriptTurns(row.transcript),
    };
  }),
});

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


const usersRouter = t.router({
  /** Everyone with twin access: how many twins, minutes given and used (active assignments). */
  list: studioProcedure.query(async ({ ctx }) => {
    const rows = await db.twinAssignment.findMany({
      where: { orgId: ctx.user.orgId, status: "active" },
      select: { id: true, recipientEmail: true, minutesLimit: true, user: { select: { name: true, image: true } } },
    });
    const used = await db.$queryRaw<{ id: string; seconds: number }[]>`
      SELECT "twinAssignmentId" AS id, coalesce(sum(extract(epoch FROM (
        coalesce("endedAt", CASE WHEN status IN ('activating', 'active') THEN now() AT TIME ZONE 'UTC' ELSE "startedAt" END)
        - "startedAt"))), 0)::float8 AS seconds
      FROM "InterviewSession"
      WHERE "orgId" = ${ctx.user.orgId} AND "twinAssignmentId" IS NOT NULL AND "startedAt" IS NOT NULL
      GROUP BY "twinAssignmentId"`;
    const secondsOf = new Map(used.map((row) => [row.id, row.seconds]));
    const people = new Map<string, { email: string; name: string; image: string | null; agents: number; minutes: number; used: number }>();
    for (const row of rows) {
      const person = people.get(row.recipientEmail)
        ?? { email: row.recipientEmail, name: row.user?.name || row.recipientEmail, image: row.user?.image ?? null, agents: 0, minutes: 0, used: 0 };
      person.agents += 1;
      person.minutes += row.minutesLimit;
      person.used += (secondsOf.get(row.id) ?? 0) / 60;
      people.set(row.recipientEmail, person);
    }
    return [...people.values()]
      .map((person) => ({ ...person, used: Math.round(person.used) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }),
});

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
      where: { id: input.id, session: { orgId: ctx.user.orgId } },
      select: {
        createdAt: true,
        turns: true,
        offTurns: true,
        session: { select: { startedAt: true, transcript: true, agent: { select: { slug: true, name: true, persona: personaFace } } } },
        ratings: { orderBy: { turnIndex: "asc" }, select: { turnIndex: true, question: true, reply: true, rating: true } },
      },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Calibration not found" });
    // The saved transcript usually comes from the voice agent, so ratings are matched to it by the reply they rated.
    const turns = attachRatings(transcriptTurns(row.session.transcript), row.ratings)
      .map((turn, i) => ({ id: String(i), speaker: turn.who === "twin" ? "twin" as const : "you" as const, text: turn.text, rating: turn.rating }));
    return {
      score: savedScore(row, transcriptTurns(row.session.transcript)),
      slug: row.session.agent.slug,
      twinName: row.session.agent.name,
      photoUrl: aiAvatarUrl(row.session.agent.persona),
      startedAt: (row.session.startedAt ?? row.createdAt).toISOString(),
      turns,
    };
  }),

  /** Marks a just-started twin call as a calibration (idempotent). */
  start: studioProcedure
    .input(slugInput.extend({ sessionId: z.string().min(1).max(100) }))
    .mutation(({ ctx, input }) => twinCall(async () => {
      const found = await findTwinAgent(ctx.user.orgId, input.slug);
      const session = await db.interviewSession.findFirst({
        where: { id: input.sessionId, orgId: ctx.user.orgId, userId: ctx.user.id, agentId: found.id },
        select: { id: true },
      });
      if (!session) throw new TwinAccessError("That call is not yours to calibrate", 404);
      const calibration = await db.twinCalibration.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, createdByUserId: ctx.user.id },
        update: {},
        select: { id: true },
      });
      return { calibrationId: calibration.id };
    })),

  /**
   * Right after a calibration call ends: Jev counts the trainer's real turns and the "Feels off" they meant (mis-clicks
   * and feedback lines left out), saved on the calibration. Raw counts if Jev can't be reached.
   */
  score: studioProcedure
    .input(z.object({ calibrationId: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const found = await db.twinCalibration.findFirst({ where: { id: input.calibrationId, session: { orgId: ctx.user.orgId } }, select: { id: true } });
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Calibration not found" });
      return scoreCalibration(ctx.user.orgId, found.id);
    }),

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
      const calibration = await db.twinCalibration.findFirst({
        where: { id: input.calibrationId, session: { orgId: ctx.user.orgId } },
        select: { id: true },
      });
      if (!calibration) throw new TRPCError({ code: "NOT_FOUND", message: "Calibration not found" });
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
      videoKey: z.string().min(1).max(500),
      voiceId: z.string().min(1).max(100),
      /** The chosen AI version (a key from headshot); null keeps the photo as taken. */
      headshotKey: z.string().min(1).max(500).nullable().optional(),
    }))
    .mutation(({ ctx, input }) => twinCall(() => saveAvatar(ctx.user.orgId, input))),
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
