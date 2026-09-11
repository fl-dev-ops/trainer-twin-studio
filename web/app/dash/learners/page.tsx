import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { LearnersView, type LearnerData, type LearnerSessionItem } from "@/components/learners-view";
import { isSessionReport, type KeyMoment, type SessionReport } from "@/lib/session-report";

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

        const evidenceObj =
          typeof s.evidence === "object" && s.evidence !== null && !Array.isArray(s.evidence)
            ? (s.evidence as Record<string, unknown>)
            : {};

        const fallbackTags = Object.keys(evidenceObj).map((k) =>
          k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        );

        const transcriptArray = Array.isArray(s.transcript) ? s.transcript : [];
        const userTurns = transcriptArray.filter(
          (t: unknown) =>
            typeof t === "object" &&
            t !== null &&
            ((t as { role?: string }).role === "user" || (t as { speaker?: string }).speaker === "learner") &&
            typeof (t as { text?: unknown }).text === "string"
        ) as Array<{ text: string }>;

        const moments: KeyMoment[] =
          report?.keyMoments && report.keyMoments.length > 0
            ? report.keyMoments
            : userTurns.slice(0, 3).map((turn, i) => ({
                id: `${s.id}-m${i + 1}`,
                number: String(i + 1).padStart(2, "0"),
                timestamp: `${i * 2 + 1}:15`,
                title: `Key exchange ${i + 1}`,
                quote: `“${turn.text}”`,
                description: "Spoken contribution recorded during the scenario dialogue.",
              }));

        return {
          id: s.id,
          title: s.agentSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          attempt: attemptNumber,
          durationMinutes: durationMin,
          formattedDate: formatted,
          dateSubtitle: `${formatted} / Attempt ${attemptNumber} / ${durationMin} min`,
          summary:
            report?.summary ||
            (typeof evidenceObj.summary === "string" && evidenceObj.summary) ||
            `${userName} completed the scenario practice run.`,
          summaryTags:
            report?.summaryTags && report.summaryTags.length > 0
              ? report.summaryTags
              : fallbackTags.length > 0
                ? fallbackTags.slice(0, 3)
                : ["Completed", "Evaluated"],
          keyMoments: moments,
          focusNextTime:
            report?.focusNextTime ||
            (typeof evidenceObj.focusNextTime === "string" && evidenceObj.focusNextTime) ||
            "Continue building problem decomposition depth in follow-up sessions.",
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
