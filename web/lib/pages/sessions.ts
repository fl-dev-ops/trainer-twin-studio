import { TRPCError } from "@trpc/server";
import { RANGE_OPTIONS } from "@/components/sessions/session-range";
import { db } from "@/lib/db";
import type { AgentKind } from "@/lib/generated/prisma/client";
import { isSessionReport, normalizeSessionReportStatus } from "@/lib/session-report";
import { firstExchange } from "@/lib/session-snippet";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

export type SessionsFilters = { range?: string; scenario?: string; learner?: string };

/** Start of the date-range filter, `days` back from now. */
const since = (days: number) => new Date(Date.now() - days * DAY_MS);

/** Sessions list for one org and module (twin or role play): filters from the URL, newest first. */
export async function loadSessionsList(orgId: string, params: SessionsFilters, kind: AgentKind) {
  const range = RANGE_OPTIONS.some((o) => o.value === params.range) ? params.range! : "30";
  const scenario = params.scenario || "all";
  const learner = params.learner || "all";

  const baseWhere = { orgId, deletedAt: null, agent: { kind } };
  const [sessions, scenarios, learners] = await Promise.all([
    db.interviewSession.findMany({
      where: {
        ...baseWhere,
        ...(scenario !== "all" ? { agentId: scenario } : {}),
        ...(learner !== "all" ? { userId: learner } : {}),
        ...(range !== "all" ? { createdAt: { gte: since(Number(range)) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      select: {
        id: true,
        status: true,
        createdAt: true,
        startedAt: true,
        transcript: true,
        agentSlug: true,
        agent: { select: { name: true } },
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    }),
    db.agent.findMany({ where: { orgId, kind }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.interviewSession.findMany({
      where: baseWhere,
      distinct: ["userId"],
      select: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  return {
    range,
    scenario,
    learner,
    pageSize: PAGE_SIZE,
    scenarios: scenarios.map((a) => ({ value: a.id, label: a.name })),
    learners: learners
      .map(({ user }) => ({ value: user.id, label: user.name || user.email }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    // The transcript stays on the server: the list only shows its first exchange.
    sessions: sessions.map(({ transcript, ...session }) => ({ ...session, ...firstExchange(transcript) })),
  };
}

export type SessionsListData = Awaited<ReturnType<typeof loadSessionsList>>;

type Turn = { role?: string; text?: string };

/** One session (V2 prototype): who/when + recording, the AI evaluation, then the transcript. */
export async function loadSessionDetail(orgId: string, id: string) {
  const row = await db.interviewSession.findFirst({
    where: { id, orgId, deletedAt: null },
    select: {
      id: true,
      status: true,
      agentId: true,
      agentSlug: true,
      createdAt: true,
      startedAt: true,
      endedAt: true,
      transcript: true,
      evidence: true,
      videoEgressId: true,
      report: true,
      reportStatus: true,
      agent: { select: { name: true, persona: { select: { name: true } } } },
      user: { select: { name: true, email: true, image: true } },
    },
  });
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });

  const evidence = (row.evidence ?? {}) as Record<string, unknown>;
  const report = isSessionReport(row.report) ? row.report : null;
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    user: row.user,
    learner: row.user.name || row.user.email,
    trainer: row.agent.persona.name || "Trainer",
    scenario: row.agent.name || row.agentSlug,
    at: row.startedAt ?? row.createdAt,
    hasVideo: Boolean(row.videoEgressId || evidence.videoS3Key || evidence.videoUrl),
    minutes:
      row.startedAt && row.endedAt ? Math.max(1, Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 60_000)) : null,
    report,
    reportState: normalizeSessionReportStatus(row.reportStatus, Boolean(report)),
    transcript: ((Array.isArray(row.transcript) ? row.transcript : []) as Turn[]).filter((t) => t.text?.trim()),
  };
}

export type SessionDetailData = Awaited<ReturnType<typeof loadSessionDetail>>;
