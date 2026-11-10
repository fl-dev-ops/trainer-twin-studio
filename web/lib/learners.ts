import { db } from "@/lib/db";
import type { AgentKind } from "@/lib/generated/prisma/client";
import { creditsLeftFor } from "@/lib/minutes";
import { LEARNER, orgPeople } from "@/lib/org-people";

type Person = { id: string; name: string; email: string; image: string | null };

export type LearnerRow = {
  email: string;
  name: string;
  userId: string;
  image: string | null;
  scenarioCount: number;
  sessionCount: number;
  practiceSeconds: number;
  lastActiveAt: string | null;
};

type Inputs = {
  /** The org's learners (lib/org-people.ts): every row is one of them. */
  learners: Person[];
  assignments: { userId: string; agentId: string }[];
  sessions: { agentId: string; user: { id: string }; startedAt: Date | null; endedAt: Date | null; createdAt: Date }[];
};

// shortcut: a session whose end was never recorded is not counted; a runaway one is capped.
// Upgrade to the usage ledger's connected_seconds once it is migrated and live.
const MAX_SESSION_SECONDS = 3 * 60 * 60;

/** One row per learner: what they're assigned and how much they've practised. Sessions of anyone else are ignored. */
export function summarizeLearners({ learners, assignments, sessions }: Inputs): LearnerRow[] {
  const rows = new Map(learners.map((person) => [person.id, {
    email: person.email.toLowerCase(),
    name: person.name || person.email,
    userId: person.id,
    image: person.image,
    scenarioCount: 0,
    sessionCount: 0,
    practiceSeconds: 0,
    lastActiveAt: null as string | null,
    scenarios: new Set<string>(),
  }]));

  for (const { userId, agentId } of assignments) rows.get(userId)?.scenarios.add(agentId);
  for (const session of sessions) {
    const entry = rows.get(session.user.id);
    if (!entry) continue;
    entry.scenarios.add(session.agentId);
    entry.sessionCount += 1;
    if (session.startedAt && session.endedAt) {
      const seconds = (session.endedAt.getTime() - session.startedAt.getTime()) / 1000;
      if (seconds > 0) entry.practiceSeconds += Math.min(seconds, MAX_SESSION_SECONDS);
    }
    const at = (session.startedAt ?? session.createdAt).toISOString();
    if (!entry.lastActiveAt || at > entry.lastActiveAt) entry.lastActiveAt = at;
  }

  return [...rows.values()]
    .map(({ scenarios, ...rest }) => ({ ...rest, scenarioCount: scenarios.size }))
    .sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") || a.name.localeCompare(b.name));
}

/** One Users-page row: a person with their per-module session counts and total practice time. */
export type UsersRow = {
  email: string;
  name: string;
  userId: string;
  image: string | null;
  twinSessions: number;
  roleplaySessions: number;
  practiceSeconds: number;
  /** Credits (practice minutes) left, shared by twins and role plays; null for admin and team, who don't use any. */
  minutesLeft: number | null;
  /** Credits given in total (grants; the per-learner cap counts these); null for admin and team. */
  minutesGiven: number | null;
  lastActiveAt: string | null;
};

/** Everyone in the org's learner pool, twin and role-play counts merged by email (the Users page). */
export async function listUsers(orgId: string): Promise<UsersRow[]> {
  const [twin, roleplay] = await Promise.all([listLearners(orgId, "TWIN"), listLearners(orgId, "ROLEPLAY")]);
  const byEmail = new Map<string, UsersRow>();
  for (const [rows, field] of [
    [twin, "twinSessions"],
    [roleplay, "roleplaySessions"],
  ] as const) {
    for (const row of rows) {
      const key = row.email.toLowerCase();
      const merged = byEmail.get(key) ?? {
        email: key,
        name: row.name,
        userId: row.userId,
        image: row.image,
        twinSessions: 0,
        roleplaySessions: 0,
        practiceSeconds: 0,
        minutesLeft: 0,
        minutesGiven: 0,
        lastActiveAt: row.lastActiveAt,
      };
      merged.name ||= row.name;
      merged.userId ||= row.userId;
      merged.image ||= row.image;
      merged[field] = row.sessionCount;
      merged.practiceSeconds += row.practiceSeconds;
      if ((row.lastActiveAt ?? "") > (merged.lastActiveAt ?? "")) merged.lastActiveAt = row.lastActiveAt;
      byEmail.set(key, merged);
    }
  }
  const credits = await creditsLeftFor(orgId, [...byEmail.keys()]);
  for (const row of byEmail.values()) {
    const own = credits.get(row.email);
    row.minutesLeft = own ? own.left : null;
    row.minutesGiven = own ? own.given : null;
  }
  return [...byEmail.values()].sort(
    (a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") || a.name.localeCompare(b.name),
  );
}

/** The org's learners for one module: their twin or role-play assignments and that module's sessions. */
export async function listLearners(orgId: string, kind: AgentKind): Promise<LearnerRow[]> {
  const [learners, assignments, sessions] = await Promise.all([
    orgPeople(orgId, { roles: [LEARNER], includeDisabled: true }),
    kind === "ROLEPLAY"
      ? db.rolePlayAssignment.findMany({
          where: { orgId, status: { in: ["pending", "used"] } },
          select: { member: { select: { userId: true } }, deployment: { select: { agentId: true } } },
        }).then((rows) => rows.map((a) => ({ userId: a.member.userId, agentId: a.deployment.agentId })))
      : db.twinAssignment.findMany({ where: { orgId, status: "active" }, select: { userId: true, agentId: true } }),
    db.interviewSession.findMany({
      where: { orgId, deletedAt: null, agent: { kind } },
      select: { agentId: true, startedAt: true, endedAt: true, createdAt: true, user: { select: { id: true } } },
    }),
  ]);
  return summarizeLearners({
    learners: learners.map((person) => ({ id: person.userId, name: person.name, email: person.email, image: person.image })),
    assignments,
    sessions,
  });
}

/** Who an assign dialog can pick: the org's learners (enabled), oldest first. */
export async function assignablePeople(orgId: string): Promise<{ userId: string; email: string; name: string; image: string | null }[]> {
  return (await orgPeople(orgId, { roles: [LEARNER] })).map(({ userId, email, name, image }) => ({ userId, email, name, image }));
}
