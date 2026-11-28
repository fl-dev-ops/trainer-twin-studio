import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { isSessionReport, type SessionReport } from "@/lib/session-report";

/**
 * What the copilot may read beyond twins, role plays and personas (plans/copilot-everywhere.md, "Phase 2"). Everything
 * it reads goes to the model provider and into traces, so each answer is built field by field here, from an explicit
 * list; no database row is ever passed through. Decided rules:
 *
 * - Learners are named, never identified by email (not even masked). No name means "Unnamed learner", never the email
 *   the dash falls back to. Name filters match names only, so the model can't test whether an email exists.
 * - Transcripts and feedback notes are read in full, one session per call.
 * - Never: secrets and codes (share codes, tokens, activation keys, API keys), recordings or links to them, files a
 *   learner uploaded or their names, IP hashes, the embedding website, billing (any of it), team members' emails, or
 *   another organization's data (every query is scoped by the org the web proxy authenticated, never by the model).
 *
 * The pure mappers are exported for the privacy contract tests (tests/lib/copilot-reads.test.ts).
 */

export const UNNAMED_LEARNER = "Unnamed learner";
const LIST_LIMIT = 20;
const TURNS_PER_PAGE = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

type Kind = "twin" | "roleplay" | "bot";
const KIND_OF: Record<string, Kind> = { TWIN: "twin", ROLEPLAY: "roleplay", BOT: "bot" };
const DB_KIND: Record<Kind, "TWIN" | "ROLEPLAY" | "BOT"> = { twin: "TWIN", roleplay: "ROLEPLAY", bot: "BOT" };

/** A person's display name, or null when there is none (or the "name" is really an email address). */
export function nameOnly(name: string | null | undefined): string | null {
  const clean = name?.replace(/\s+/g, " ").trim();
  if (!clean || /\S+@\S+\.\S+/.test(clean)) return null;
  return clean.slice(0, 120);
}

/** The learner as the copilot may name them: their name, a website visitor's self-reported name, or "Unnamed learner". */
export const learnerName = (user: { name: string | null } | null, anonymousName: string | null) =>
  nameOnly(user?.name) ?? nameOnly(anonymousName) ?? UNNAMED_LEARNER;

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
const minutesBetween = (start: Date | null, end: Date | null) =>
  start && end && end > start ? Math.round((end.getTime() - start.getTime()) / 6000) / 10 : null;

/** The report, field by field: no recording links (`audioUrl`), no internal ids. */
export function reportFields(report: SessionReport) {
  return {
    summary: report.summary,
    tags: report.summaryTags,
    focusNextTime: report.focusNextTime,
    ...(typeof report.score === "number" ? { score: report.score } : {}),
    keyMoments: report.keyMoments.map((moment) => ({
      number: moment.number,
      title: moment.title,
      quote: moment.quote,
      description: moment.description,
    })),
    ...(report.rubricScores ? {
      rubric: report.rubricScores.map((row) => ({ criterion: row.criterion, points: row.points, maxPoints: row.maxPoints, reason: row.reason })),
    } : {}),
    ...(report.goalResults ? {
      goals: report.goalResults.map((row) => ({ goal: row.goal, status: row.status, evidence: row.evidence })),
    } : {}),
  };
}

/** The columns a session summary is built from: what is selected is what may be read (plus nothing else). */
const summarySelect = {
  id: true, status: true, mode: true, createdAt: true, startedAt: true, endedAt: true, reportStatus: true, report: true,
  feedbackRating: true, anonymousName: true,
  user: { select: { name: true } },
  agent: { select: { name: true, slug: true, kind: true } },
} satisfies Prisma.InterviewSessionSelect;
type SummaryRow = Prisma.InterviewSessionGetPayload<{ select: typeof summarySelect }>;

export function sessionSummary(row: SummaryRow) {
  const report = isSessionReport(row.report) ? row.report : null;
  return {
    id: row.id,
    kind: KIND_OF[row.agent.kind] ?? "twin",
    agent: { name: row.agent.name || row.agent.slug, slug: row.agent.slug },
    learner: learnerName(row.user, row.anonymousName),
    mode: row.mode === "chat" ? "chat" : "voice",
    status: row.status,
    startedAt: iso(row.startedAt ?? row.createdAt),
    minutes: minutesBetween(row.startedAt, row.endedAt),
    report: report ? "ready" : row.reportStatus === "generating" ? "generating" : "none",
    ...(report && typeof report.score === "number" ? { score: report.score } : {}),
    ...(report ? { tags: report.summaryTags } : {}),
    ...(typeof row.feedbackRating === "number" ? { learnerRating: row.feedbackRating } : {}),
  };
}

const detailSelect = {
  ...summarySelect,
  transcript: true, feedbackNote: true,
  // Only to say whether a recording exists; never sent on.
  s3AudioKey: true, audioEgressId: true, videoEgressId: true,
} satisfies Prisma.InterviewSessionSelect;
type DetailRow = Prisma.InterviewSessionGetPayload<{ select: typeof detailSelect }>;

/** A transcript turn: who spoke and what they said. No timings, ids, audio or attachments. */
export function transcriptTurns(transcript: unknown, otherSpeaker: string) {
  const turns = Array.isArray(transcript) ? transcript : [];
  return turns.flatMap((turn) => {
    if (!turn || typeof turn !== "object") return [];
    const { role, text } = turn as { role?: unknown; text?: unknown };
    if (typeof text !== "string" || !text.trim()) return [];
    const learner = role === "user" || role === "learner";
    return [{ speaker: learner ? "learner" : otherSpeaker, text: text.trim() }];
  });
}

export function sessionDetail(row: DetailRow, fromTurn = 1) {
  const report = isSessionReport(row.report) ? row.report : null;
  const turns = transcriptTurns(row.transcript, row.agent.kind === "ROLEPLAY" ? "role play" : "twin");
  const start = Math.max(1, Math.min(fromTurn, Math.max(1, turns.length)));
  const page = turns.slice(start - 1, start - 1 + TURNS_PER_PAGE);
  const next = start - 1 + TURNS_PER_PAGE < turns.length ? start + TURNS_PER_PAGE : null;
  return {
    ...sessionSummary(row),
    hasRecording: Boolean(row.s3AudioKey || row.audioEgressId || row.videoEgressId),
    ...(report ? { report: reportFields(report) } : {}),
    ...(row.feedbackNote?.trim() ? { learnerFeedback: row.feedbackNote.trim() } : {}),
    transcript: {
      totalTurns: turns.length,
      fromTurn: start,
      turns: page.map((turn, index) => ({ n: start + index, ...turn })),
      ...(next ? { nextFromTurn: next } : {}),
    },
  };
}

export type SessionListInput = { kind?: Kind; learner?: string; agent?: string; days?: 7 | 30 | 90; offset?: number };

export async function listSessions(orgId: string, input: SessionListInput) {
  const since = new Date(Date.now() - (input.days ?? 30) * DAY_MS);
  const offset = input.offset ?? 0;
  const learner = input.learner?.trim();
  const rows = await db.interviewSession.findMany({
    where: {
      orgId,
      deletedAt: null,
      createdAt: { gte: since },
      agent: { orgId, ...(input.kind ? { kind: DB_KIND[input.kind] } : {}), ...(input.agent ? { slug: input.agent } : {}) },
      // Names only: never the email, so a filter can't be used to find out whose address is whose.
      ...(learner ? { OR: [
        { user: { name: { contains: learner, mode: "insensitive" as const } } },
        { anonymousName: { contains: learner, mode: "insensitive" as const } },
      ] } : {}),
    },
    orderBy: { createdAt: "desc" },
    skip: offset,
    take: LIST_LIMIT + 1,
    select: summarySelect,
  });
  return {
    days: input.days ?? 30,
    sessions: rows.slice(0, LIST_LIMIT).map(sessionSummary),
    ...(rows.length > LIST_LIMIT ? { nextOffset: offset + LIST_LIMIT } : {}),
  };
}

export async function readSession(orgId: string, sessionId: string, fromTurn?: number) {
  const row = await db.interviewSession.findFirst({ where: { id: sessionId, orgId, deletedAt: null }, select: detailSelect });
  return row ? sessionDetail(row, fromTurn) : null;
}

/** A trainer's calibrations of the twin: when, which twin, how many answers were off. Not the ratings' text. */
export async function listCalibrations(orgId: string, input: { twin?: string; offset?: number }) {
  const offset = input.offset ?? 0;
  const rows = await db.twinCalibration.findMany({
    where: { session: { orgId, deletedAt: null, ...(input.twin ? { agent: { slug: input.twin } } : {}) } },
    orderBy: { createdAt: "desc" },
    skip: offset,
    take: LIST_LIMIT + 1,
    select: {
      createdAt: true, turns: true, offTurns: true, scoredAt: true, createdByUserId: true,
      session: { select: { id: true, agent: { select: { name: true, slug: true } } } },
    },
  });
  const page = rows.slice(0, LIST_LIMIT);
  const people = await db.user.findMany({ where: { id: { in: [...new Set(page.map((row) => row.createdByUserId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(people.map((person) => [person.id, nameOnly(person.name)]));
  return {
    calibrations: page.map((row) => ({
      sessionId: row.session.id,
      twin: { name: row.session.agent.name || row.session.agent.slug, slug: row.session.agent.slug },
      by: nameOf.get(row.createdByUserId) ?? "A team member",
      at: iso(row.createdAt),
      answers: row.turns,
      offAnswers: row.offTurns,
      scored: Boolean(row.scoredAt),
    })),
    ...(rows.length > LIST_LIMIT ? { nextOffset: offset + LIST_LIMIT } : {}),
  };
}

/**
 * Minutes used in the last 7, 30 or 90 days: by twin / role play, and by person (learners' calls, and the team's own
 * calls). Only usage: no balance, grants or credit movements (billing is out of reach), no ledger notes, no emails.
 */
const WEBSITE_VISITORS = "Website visitors";

export async function readUsage(orgId: string, days: 7 | 30 | 90 = 30) {
  const since = new Date(Date.now() - days * DAY_MS);
  const [byAgent, byPerson] = await Promise.all([
    db.$queryRaw<{ name: string | null; slug: string | null; kind: string | null; seconds: bigint }[]>`
      SELECT a."name", a."slug", a."kind"::text AS kind, SUM(ABS(l."seconds"))::bigint AS seconds
      FROM "MinuteLedger" l
      LEFT JOIN "InterviewSession" s ON s."id" = l."sessionId"
      LEFT JOIN "Agent" a ON a."id" = s."agentId"
      WHERE l."orgId" = ${orgId} AND l."type" IN ('usage', 'org_usage') AND l."createdAt" >= ${since}
      GROUP BY a."name", a."slug", a."kind"
      ORDER BY seconds DESC`,
    db.$queryRaw<{ userId: string | null; type: string; seconds: bigint }[]>`
      SELECT l."userId", l."type", SUM(ABS(l."seconds"))::bigint AS seconds
      FROM "MinuteLedger" l
      WHERE l."orgId" = ${orgId} AND l."type" IN ('usage', 'org_usage') AND l."createdAt" >= ${since}
      GROUP BY l."userId", l."type"
      ORDER BY seconds DESC`,
  ]);
  const ids = [...new Set(byPerson.map((row) => row.userId).filter((id): id is string => Boolean(id)))];
  const people = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(people.map((person) => [person.id, nameOnly(person.name)]));
  const minutes = (seconds: bigint) => Math.round(Number(seconds) / 6) / 10;
  return {
    days,
    byAgent: byAgent.map((row) => ({
      name: row.name || row.slug || "Deleted agent",
      kind: (row.kind && KIND_OF[row.kind]) ?? "unknown",
      minutes: minutes(row.seconds),
    })),
    byPerson: byPerson.map((row) => ({
      // Minutes with no account behind them are website visitors' calls on a public bot, counted together.
      name: row.userId ? nameOf.get(row.userId) || UNNAMED_LEARNER : WEBSITE_VISITORS,
      as: row.type === "usage" ? "learner" : "team",
      minutes: minutes(row.seconds),
    })),
  };
}

/** The studio's team: names, roles and whether they're disabled. Never emails. */
export async function listTeam(orgId: string) {
  const members = await db.member.findMany({
    where: { organizationId: orgId, role: { in: ["admin", "team"] } },
    orderBy: { createdAt: "asc" },
    select: { role: true, createdAt: true, disabledAt: true, user: { select: { name: true } } },
  });
  return {
    team: members.map((member) => ({
      name: nameOnly(member.user.name) ?? "Unnamed member",
      role: member.role,
      disabled: Boolean(member.disabledAt),
      since: iso(member.createdAt),
    })),
  };
}

/** The organization: its name, address in the studio, website, and how much it has. No billing, no keys. */
export async function readOrg(orgId: string) {
  const [org, twins, roleplays, personas, knowledgeBases] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, slug: true, websiteUrl: true } }),
    db.agent.count({ where: { orgId, kind: "TWIN", archivedAt: null } }),
    db.agent.count({ where: { orgId, kind: "ROLEPLAY", archivedAt: null } }),
    db.persona.count({ where: { orgId } }),
    db.knowledgeBase.count({ where: { orgId } }),
  ]);
  return { name: org.name, slug: org.slug, website: org.websiteUrl ?? null, counts: { twins, roleplays, personas, knowledgeBases } };
}
