import { db } from "@/lib/db";

/**
 * Single-org lock: a person (by email) belongs to exactly one organization — the org of their
 * earliest membership, live assignment, or session. Multi-org is a separate, later release.
 * shortcut: derived from existing rows (no column/constraint); move to a User.homeOrgId column
 * with a DB constraint when multi-org lands.
 */
export const ORG_LOCK_MESSAGE = "This person already belongs to another organization.";

export class OrgLockError extends Error {
  constructor() {
    super(ORG_LOCK_MESSAGE);
    this.name = "OrgLockError";
  }
}

/** Home org per lowercased email; emails with no org binding yet are absent. */
export async function homeOrgsByEmail(emails: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return new Map();

  const [members, assignments, sessions] = await Promise.all([
    db.member.findMany({
      where: { user: { email: { in: wanted } } },
      select: { organizationId: true, createdAt: true, user: { select: { email: true } } },
    }),
    db.rolePlayAssignment.findMany({
      // cancelled/expired invitations never bound anyone; emails are stored lowercase (better-auth + assignments)
      where: { recipientEmail: { in: wanted }, status: { in: ["pending", "used"] } },
      select: { orgId: true, assignedAt: true, recipientEmail: true },
    }),
    db.interviewSession.findMany({
      where: { user: { email: { in: wanted } } },
      select: { orgId: true, createdAt: true, user: { select: { email: true } } },
    }),
  ]);

  const earliest = new Map<string, { orgId: string; at: number }>();
  const consider = (email: string, orgId: string, at: Date) => {
    const key = email.toLowerCase();
    const current = earliest.get(key);
    if (!current || at.getTime() < current.at) earliest.set(key, { orgId, at: at.getTime() });
  };
  for (const m of members) consider(m.user.email, m.organizationId, m.createdAt);
  for (const a of assignments) consider(a.recipientEmail, a.orgId, a.assignedAt);
  for (const s of sessions) consider(s.user.email, s.orgId, s.createdAt);
  return new Map([...earliest].map(([email, { orgId }]) => [email, orgId]));
}

/** True when the email is already bound to an org other than `orgId`. */
export async function belongsToOtherOrg(email: string, orgId: string): Promise<boolean> {
  const home = (await homeOrgsByEmail([email])).get(email.trim().toLowerCase());
  return home !== undefined && home !== orgId;
}

/** Throws OrgLockError when the user is bound to a different org. */
export async function assertUserInOrg(userId: string, orgId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (user && (await belongsToOtherOrg(user.email, orgId))) throw new OrgLockError();
}
