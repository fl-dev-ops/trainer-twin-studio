import { BASE_DOMAIN } from "@/lib/base-domain";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { orgName, personEmailFor } from "@/lib/invite/person-email";
import { learnerBalance } from "@/lib/minutes";
import { addPeopleToOrg, LEARNER, orgPerson, peopleLock, peopleRefusals, type AddedPerson, type OrgPerson } from "@/lib/org-people";
import { db, withLock } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { giveRoleplay } from "@/lib/invite/roleplay";
import { deliverEmail } from "@/lib/queue-emails";

/** Shared by /api/v1/assignments and /api/v1/assignments/:id (docs/openapi.yaml, Assignments). */

export const practiceUrl = (orgSlug: string, shareCode: string) => `https://${orgSlug}.${BASE_DOMAIN}/s/${shareCode}`;

/** A published scenario: a role play of the org that is not archived (twins use twin assignments). */
export function findScenario(orgId: string, slug: string) {
  return db.agent.findFirst({
    where: { orgId, slug, kind: "ROLEPLAY", archivedAt: null },
    select: { id: true, slug: true, name: true, data: true },
  });
}

/**
 * The learner an API call names and their link to a role play, in one locked transaction (specs/practice.md rule 19):
 * by email (added to the org as a learner when new, with starting credits) or an existing learner by userId (a
 * disabled or team person is refused like the dashboard). An open link is kept (`created: false`). `moveFrom`: the
 * API's move of a link (PATCH): that link is cancelled and a new one made, refused when the target already has an
 * open one (`assignment_exists`). Null: no such learner.
 */
export async function assignScenario(input: {
  orgId: string;
  by: { userId?: string; email?: string };
  deploymentId: string;
  trainerUserId: string;
  moveFrom?: string;
}) {
  let created = false;
  const write = async (tx: Prisma.TransactionClient, person: OrgPerson) => {
    const open = await tx.rolePlayAssignment.findFirst({ where: { deploymentId: input.deploymentId, memberId: person.memberId, status: { in: ["pending", "used"] } }, select: { id: true } });
    if (open && input.moveFrom) throw new AppError("assignment_exists", "That learner already has this role play.", 409);
    if (!open) created = (await giveRoleplay(tx, { orgId: input.orgId, deploymentId: input.deploymentId, people: [person], byUserId: input.trainerUserId })).links.length > 0;
    if (input.moveFrom) await tx.rolePlayAssignment.update({ where: { id: input.moveFrom }, data: { status: "cancelled" } });
  };
  const person: AddedPerson | null = input.by.email
    ? (await addPeopleToOrg({ orgId: input.orgId, emails: [input.by.email], role: LEARNER, byUserId: input.trainerUserId, then: (tx, [added]) => write(tx, added) }))[0]
    : await withLock([peopleLock(input.orgId)], async (tx) => {
        const found = await orgPerson(input.orgId, { userId: input.by.userId! }, tx);
        if (!found) return null;
        if (found.disabled) throw peopleRefusals.personDisabled([found.email]);
        if (found.role !== LEARNER) throw peopleRefusals.personIsStudio([found.email]);
        await write(tx, found);
        return { ...found, added: false, startingCredits: 0 };
      });
  if (!person) return null;
  const assignment = await db.rolePlayAssignment.findUniqueOrThrow({
    where: { deploymentId_memberId: { deploymentId: input.deploymentId, memberId: person.memberId } },
    select: { id: true, assignedAt: true, shareCode: true },
  });
  return { person, assignment, created };
}

/** The assignment email ("added" too when they joined just now); delivery failure never undoes it (`emailSent`). */
export async function emailAssignment(input: {
  org: { id: string; slug: string };
  /** One email per assignment link: a background retry (workflows/send-emails.ts) can't send it twice. */
  idempotencyKey: string;
  person: AddedPerson;
  scenario: { name: string; data: unknown };
  practiceUrl: string;
  trainerName: string;
}) {
  const data = input.scenario.data as { objective?: unknown } | null;
  const upload = contextUploadFromAgentData(input.scenario.data);
  const { balanceSeconds } = await learnerBalance(input.org.id, input.person.email);
  const email = personEmailFor({
    person: input.person,
    org: { slug: input.org.slug, name: await orgName(input.org.id) },
    by: { name: input.trainerName },
    key: input.idempotencyKey,
    roleplay: {
      name: input.scenario.name,
      url: input.practiceUrl,
      objective: typeof data?.objective === "string" ? data.objective : undefined,
      requiredArtifact: upload.required && upload.prompt ? { label: upload.label, prompt: upload.prompt } : null,
    },
    balance: Math.floor(Math.max(0, balanceSeconds) / 60),
  });
  // Sent now (the response says whether it went); a failure keeps being retried in the background.
  return (await deliverEmail({ ...email, idempotencyKey: input.idempotencyKey })).sent;
}

/** The documented `Assignment` object (POST and PATCH responses). */
export const assignmentView = (row: { id: string; assignedAt: Date }, email: string, userId: string, scenario: string) =>
  ({ id: row.id, assignedAt: row.assignedAt, userId, email, scenario });

export const assignmentDetailSelect = {
  id: true,
  assignedAt: true,
  shareCode: true,
  status: true,
  member: { select: { user: { select: { id: true, name: true, email: true } } } },
  deployment: { select: { agent: { select: { slug: true, name: true, version: true, visibility: true } } } },
} as const;

type DetailRow = {
  id: string;
  assignedAt: Date;
  shareCode: string;
  status: string;
  member: { user: { id: string; name: string; email: string } };
  deployment: { agent: { slug: string; name: string; version: number; visibility: string } };
};

/** The documented `AssignmentDetail` objects: the learner is always the assignment's member (specs/people.md). */
export async function assignmentDetails(orgId: string, orgSlug: string, rows: DetailRow[]) {
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
    user: { ...row.member.user, email: row.member.user.email.toLowerCase() },
    scenario: row.deployment.agent,
    practiceUrl: practiceUrl(orgSlug, row.shareCode),
  }));
}
