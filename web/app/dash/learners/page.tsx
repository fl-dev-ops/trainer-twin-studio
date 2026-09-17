import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { LearnersView, type LearnerData, type LearnerSessionItem } from "@/components/learners-view";
import { isSessionReport, normalizeSessionReportStatus, type SessionReport } from "@/lib/session-report";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Learners - Trainer Twin Studio",
  description: "Review your learners' completed practice sessions, key moments, and progress.",
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return (parts[0]?.slice(0, 2) || "U").toUpperCase();
}

function formatDate(date: Date): string {
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  const timeStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  if (isToday) {
    return `Today, ${timeStr}`;
  }

  const dateStr = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);

  return `${dateStr}, ${timeStr}`;
}

export default async function LearnersPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");

  // Restrict strictly to admins and owners
  const member = await db.member.findFirst({
    where: { userId: session.user.id, role: { in: ["owner", "admin"] } },
    select: { organizationId: true },
  });
  if (!member) redirect("/auth/no-org");

  // Fetch all completed sessions for this organization
  const dbSessions = await db.interviewSession.findMany({
    where: {
      orgId: member.organizationId,
      status: "completed",
      deletedAt: null,
    },
    include: {
      user: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { startedAt: "desc" },
    take: 100,
  });

  let initialLearners: LearnerData[] | undefined;

  if (dbSessions.length > 0) {
    const userGroups = new Map<string, typeof dbSessions>();
    for (const sess of dbSessions) {
      const uId = sess.userId || "anonymous";
      if (!userGroups.has(uId)) {
        userGroups.set(uId, []);
      }
      userGroups.get(uId)!.push(sess);
    }

    initialLearners = Array.from(userGroups.entries()).map(([userId, sessions], userIndex) => {
      const firstSess = sessions[0];
      const userName = firstSess.user?.name || `Learner ${userIndex + 1}`;
      const userEmail = firstSess.user?.email || undefined;

      const mappedSessions: LearnerSessionItem[] = sessions.map((s, sIndex) => {
        const started = s.startedAt ?? s.createdAt;
        const ended = s.endedAt ?? started;
        const durationMin = Math.max(1, Math.round((ended.getTime() - started.getTime()) / 60_000));
        const formatted = formatDate(started);
        const attemptNumber = s.attempt || sessions.length - sIndex;

        const report = isSessionReport(s.report) ? (s.report as SessionReport) : undefined;
        const reportStatus = normalizeSessionReportStatus(s.reportStatus, Boolean(report));

        return {
          id: s.id,
          title: s.agentSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          attempt: attemptNumber,
          durationMinutes: durationMin,
          formattedDate: formatted,
          dateSubtitle: `${formatted} / Attempt ${attemptNumber} / ${durationMin} min`,
          reportStatus,
          summary: report?.summary ?? "",
          summaryTags: report?.summaryTags ?? [],
          keyMoments: report?.keyMoments ?? [],
          focusNextTime: report?.focusNextTime ?? "",
          audioUrl: s.s3AudioKey ? `/api/sessions/${s.id}/audio` : undefined,
          report,
        };
      });

      return {
        id: userId,
        name: userName,
        email: userEmail,
        initials: getInitials(userName),
        completedSessionsCount: sessions.length,
        sessions: mappedSessions,
      };
    });
  }

  return <LearnersView initialLearners={initialLearners ?? []} />;
}
