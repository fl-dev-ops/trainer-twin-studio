import { db } from "@/lib/db";

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

export async function listLearners(orgId: string): Promise<LearnerRow[]> {
  const person = { select: { id: true, name: true, email: true, image: true } } as const;
  const [assignments, sessions, members] = await Promise.all([
    db.rolePlayAssignment.findMany({
      where: { orgId, status: { in: ["pending", "used"] } },
      select: { recipientEmail: true, deployment: { select: { agentId: true } } },
    }),
    db.interviewSession.findMany({
      where: { orgId, deletedAt: null },
      select: { agentId: true, startedAt: true, endedAt: true, createdAt: true, user: person },
    }),
    db.member.findMany({ where: { organizationId: orgId, role: "member" }, select: { user: person } }),
  ]);
  const known = new Set([...sessions.map((s) => s.user.email), ...members.map((m) => m.user.email)].map((e) => e.toLowerCase()));
  const missing = [...new Set(assignments.map((a) => a.recipientEmail.toLowerCase()))].filter((e) => !known.has(e));
  const users = missing.length ? await db.user.findMany({ where: { email: { in: missing } }, ...person }) : [];

  return summarizeLearners({
    assignments: assignments.map((a) => ({ recipientEmail: a.recipientEmail, agentId: a.deployment.agentId })),
    sessions,
    members: members.map((m) => m.user),
    users,
  });
}
