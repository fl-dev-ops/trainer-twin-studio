import { BASE_DOMAIN } from "@/lib/base-domain";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
import { learnerBalance } from "@/lib/minutes";
import { LEARNER_ROLE, STUDIO_ROLES } from "@/lib/org";

/** Shared by /api/v1/assignments and /api/v1/assignments/:id (docs/openapi.yaml, Assignments). */

export const practiceUrl = (orgSlug: string, shareCode: string) => `https://${orgSlug}.${BASE_DOMAIN}/s/${shareCode}`;

/** A published scenario: a role play of the org that is not archived (twins use twin assignments). */
export function findScenario(orgId: string, slug: string) {
  return db.agent.findFirst({
    where: { orgId, slug, kind: "ROLEPLAY", archivedAt: null },
    select: { id: true, slug: true, name: true, data: true },
  });
}

/** The trainer the key acts for: its creator while they are still a studio member (403 otherwise). */
export function findKeyTrainer(orgId: string, actorUserId: string | null) {
  return db.member.findFirst({
    where: { organizationId: orgId, role: { in: [...STUDIO_ROLES] }, ...(actorUserId ? { userId: actorUserId } : {}) },
    select: { userId: true, user: { select: { name: true } } },
  });
}

/** The assignment email; delivery failure never undoes the assignment (the caller reports `emailSent`). */
export async function emailAssignment(input: {
  orgId: string;
  to: string;
  userName?: string | null;
  scenario: { name: string; data: unknown };
  practiceUrl: string;
  trainerName: string;
}) {
  const data = input.scenario.data as { objective?: unknown } | null;
  const upload = contextUploadFromAgentData(input.scenario.data);
  const { balanceSeconds } = await learnerBalance(input.orgId, input.to);
  const delivery = await sendRolePlayAssignmentEmail({
    to: input.to,
    userName: input.userName ?? undefined,
    rolePlayName: input.scenario.name,
    rolePlayObjective: typeof data?.objective === "string" ? data.objective : undefined,
    practiceUrl: input.practiceUrl,
    trainerName: input.trainerName,
    requiredArtifact: upload.required && upload.prompt ? { label: upload.label, prompt: upload.prompt } : null,
    minutes: Math.floor(Math.max(0, balanceSeconds) / 60),
  });
  return delivery.success;
}

/** The documented `Assignment` object (POST and PATCH responses). */
export const assignmentView = (row: { id: string; assignedAt: Date }, email: string, userId: string | null, scenario: string) =>
  ({ id: row.id, assignedAt: row.assignedAt, userId, email, scenario });

export const assignmentDetailSelect = {
  id: true,
  assignedAt: true,
  shareCode: true,
  status: true,
  recipientEmail: true,
  member: { select: { user: { select: { id: true, name: true, email: true } } } },
  deployment: { select: { agent: { select: { slug: true, name: true, version: true, visibility: true } } } },
} as const;

type DetailRow = {
  id: string;
  assignedAt: Date;
  shareCode: string;
  status: string;
  recipientEmail: string;
  member: { user: { id: string; name: string; email: string } } | null;
  deployment: { agent: { slug: string; name: string; version: number; visibility: string } };
};

/**
 * The documented `AssignmentDetail` objects. The learner is the member who used the link, else the org learner with the
 * assigned email (an assignment made by userId is only bound to the member once they open it), else just the email.
 */
export async function assignmentDetails(orgId: string, orgSlug: string, rows: DetailRow[]) {
  const unbound = [...new Set(rows.filter((row) => !row.member).map((row) => row.recipientEmail))];
  const learners = unbound.length
    ? await db.member.findMany({
        where: { organizationId: orgId, role: LEARNER_ROLE, disabledAt: null, user: { email: { in: unbound } } },
        select: { user: { select: { id: true, name: true, email: true } } },
      })
    : [];
  const byEmail = new Map(learners.map(({ user }) => [user.email.toLowerCase(), user]));
  // How often each was practised: sessions that started (a role play link starts a new one each time).
  const practice = rows.length
    ? await db.interviewSession.groupBy({
        by: ["assignmentId"],
        where: { assignmentId: { in: rows.map((row) => row.id) }, startedAt: { not: null }, status: { not: "failed" } },
        _count: { _all: true },
        _max: { startedAt: true },
      })
    : [];
  const practiceById = new Map(practice.map((row) => [row.assignmentId, row]));
  return rows.map((row) => ({
    id: row.id,
    assignedAt: row.assignedAt,
    status: row.status,
    practiceCount: practiceById.get(row.id)?._count._all ?? 0,
    lastPracticedAt: practiceById.get(row.id)?._max.startedAt ?? null,
    user: row.member?.user ?? byEmail.get(row.recipientEmail) ?? { id: null, name: null, email: row.recipientEmail },
    scenario: row.deployment.agent,
    practiceUrl: practiceUrl(orgSlug, row.shareCode),
  }));
}
