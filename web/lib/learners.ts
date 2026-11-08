import { db } from "@/lib/db";
import type { AgentKind } from "@/lib/generated/prisma/client";
import { creditsLeftFor } from "@/lib/minutes";
import { LEARNER_ROLE } from "@/lib/org";

type Person = { id: string; name: string; email: string; image: string | null };

export type LearnerRow = {
  email: string;
  name: string;
  userId: string | null;
  image: string | null;
  scenarioCount: number;
  sessionCount: number;
  practiceSeconds: number;
  lastActiveAt: string | null;
};

type Inputs = {
  assignments: { recipientEmail: string; agentId: string }[];
  sessions: { agentId: string; user: Person; startedAt: Date | null; endedAt: Date | null; createdAt: Date }[];
  members: Person[];
  /** Accounts for assignment-only emails (learners who have not practised yet). */
  users: Person[];
};

// shortcut: a session whose end was never recorded is not counted; a runaway one is capped.
// Upgrade to the usage ledger's connected_seconds once it is migrated and live.
const MAX_SESSION_SECONDS = 3 * 60 * 60;

/** One row per learner (by email): what they're assigned and how much they've practised. */
export function summarizeLearners({ assignments, sessions, members, users }: Inputs): LearnerRow[] {
  const rows = new Map<string, LearnerRow & { scenarios: Set<string> }>();
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  const row = (email: string, person?: Person) => {
    const key = email.toLowerCase();
    let entry = rows.get(key);
    const account = person ?? userByEmail.get(key);
    if (!entry) {
      entry = {
        email: key,
        name: account?.name || key,
        userId: account?.id ?? null,
        image: account?.image ?? null,
        scenarioCount: 0,
        sessionCount: 0,
        practiceSeconds: 0,
        lastActiveAt: null,
        scenarios: new Set(),
      };
      rows.set(key, entry);
    } else if (account && !entry.userId) {
      Object.assign(entry, { name: account.name || entry.name, userId: account.id, image: account.image });
    }
    return entry;
  };

  for (const member of members) row(member.email, member);
  for (const { recipientEmail, agentId } of assignments) row(recipientEmail).scenarios.add(agentId);
  for (const session of sessions) {
    const entry = row(session.user.email, session.user);
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
  userId: string | null;
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

/** Learners of one module: role-play invites or twin assignments, and that module's sessions. */
export async function listLearners(orgId: string, kind: AgentKind): Promise<LearnerRow[]> {
  const person = { select: { id: true, name: true, email: true, image: true } } as const;
  const [assignments, sessions, members] = await Promise.all([
    kind === "ROLEPLAY"
      ? db.rolePlayAssignment.findMany({
          where: { orgId, status: { in: ["pending", "used"] } },
          select: { recipientEmail: true, deployment: { select: { agentId: true } } },
        }).then((rows) => rows.map((a) => ({ recipientEmail: a.recipientEmail, agentId: a.deployment.agentId })))
      : db.twinAssignment.findMany({ where: { orgId, status: "active" }, select: { recipientEmail: true, agentId: true } }),
    // Only learners' sessions: admins testing their twins ("Try as learner") don't create a Users row.
    db.interviewSession.findMany({
      where: { orgId, deletedAt: null, agent: { kind }, user: { members: { some: { organizationId: orgId, role: LEARNER_ROLE } } } },
      select: { agentId: true, startedAt: true, endedAt: true, createdAt: true, user: person },
    }),
    db.member.findMany({ where: { organizationId: orgId, role: LEARNER_ROLE }, select: { user: person } }),
  ]);
  const known = new Set([...sessions.map((s) => s.user.email), ...members.map((m) => m.user.email)].map((e) => e.toLowerCase()));
  const missing = [...new Set(assignments.map((a) => a.recipientEmail.toLowerCase()))].filter((e) => !known.has(e));
  const users = missing.length ? await db.user.findMany({ where: { email: { in: missing } }, ...person }) : [];

  return summarizeLearners({
    assignments,
    sessions,
    members: members.map((m) => m.user),
    users,
  });
}

/**
 * Who an assign dialog can pick: the org's learners, plus people invited as users (Settings > Users) who haven't
 * accepted yet (`pending`), so they can be given a twin or role play right away. Emails lowercased, members first.
 */
export async function assignablePeople(orgId: string): Promise<{ email: string; name: string; image: string | null; pending: boolean }[]> {
  const [members, invitations] = await Promise.all([
    db.member.findMany({
      where: { organizationId: orgId, role: LEARNER_ROLE },
      orderBy: { createdAt: "asc" },
      select: { user: { select: { name: true, email: true, image: true } } },
    }),
    db.invitation.findMany({
      where: { organizationId: orgId, role: LEARNER_ROLE, status: "pending", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { email: true },
    }),
  ]);
  const people = new Map<string, { email: string; name: string; image: string | null; pending: boolean }>();
  for (const { user } of members) people.set(user.email.toLowerCase(), { email: user.email.toLowerCase(), name: user.name || user.email, image: user.image, pending: false });
  for (const { email } of invitations) {
    const key = email.toLowerCase();
    if (!people.has(key)) people.set(key, { email: key, name: key, image: null, pending: true });
  }
  return [...people.values()];
}
