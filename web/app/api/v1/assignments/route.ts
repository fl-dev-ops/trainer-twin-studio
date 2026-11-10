import { z } from "zod";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { MinutesError } from "@/lib/minutes";
import { PeopleError } from "@/lib/org-people";
import { findOrgLearner, isApiError, paginationFromUrl, requireExternalApi } from "@/lib/external-api";
import {
  assignmentDetails,
  assignmentDetailSelect,
  assignmentView,
  emailAssignment,
  findKeyTrainer,
  findScenario,
  learnerFor,
  practiceUrl,
} from "@/lib/external-api-assignments";

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
}).strict().refine((value) => value.email || value.userId, "email or userId is required");

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "assignments", "read");
  if (isApiError(api)) return api;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || undefined;
  const requestedEmail = url.searchParams.get("email")?.trim().toLowerCase() || undefined;
  const scenario = url.searchParams.get("scenario") || undefined;
  const page = paginationFromUrl(url);
  if (page instanceof Response) return page;
  // A learner outside the org (or unknown) matches nothing.
  const learner = requestedEmail ? await findOrgLearner(api.org.id, { email: requestedEmail })
    : userId ? await findOrgLearner(api.org.id, { id: userId }) : null;
  const where = {
    orgId: api.org.id,
    ...(requestedEmail || userId ? { memberId: learner?.memberId ?? "" } : {}),
    ...(scenario ? { deployment: { agent: { slug: scenario } } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.rolePlayAssignment.findMany({ where, orderBy: { assignedAt: "desc" }, skip: page.offset, take: page.limit, select: assignmentDetailSelect }),
    db.rolePlayAssignment.count({ where }),
  ]);
  return Response.json({ assignments: await assignmentDetails(api.org.id, api.org.slug, rows), pagination: { ...page, total } });
}

export async function POST(request: Request) {
  const api = await requireExternalApi(request, "assignments", "write");
  if (isApiError(api)) return api;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "email or userId and a valid scenario slug are required" }, { status: 400 });

  const [agent, trainer] = await Promise.all([findScenario(api.org.id, parsed.data.scenario), findKeyTrainer(api.org.id, api.actorUserId)]);
  if (!agent) return Response.json({ error: "Scenario not found" }, { status: 404 });
  if (!trainer) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });

  // The learner: an existing one by userId, or by email (added to the org first when new, with starting credits).
  let learner;
  try {
    learner = await learnerFor(api.org.id, { email: parsed.data.email, userId: parsed.data.userId }, trainer.userId);
  } catch (error) {
    if (error instanceof PeopleError || error instanceof MinutesError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
  if (!learner) return Response.json({ error: "User not found" }, { status: 404 });
  const deployment = await ensureDeployment(api.org.id, agent.id);
  const existing = await db.rolePlayAssignment.findUnique({
    where: { deploymentId_memberId: { deploymentId: deployment.id, memberId: learner.memberId } },
    select: { id: true, assignedAt: true, shareCode: true, status: true },
  });
  // Idempotent: a live assignment (pending or used) is returned as it is, with no second email.
  if (existing && (existing.status === "pending" || existing.status === "used")) {
    return Response.json({
      assignment: assignmentView(existing, learner.email, learner.userId, agent.slug),
      practiceUrl: practiceUrl(api.org.slug, existing.shareCode),
      created: false,
    });
  }

  // New, or a cancelled / expired one reopened with a fresh link (as the dashboard's Assign does).
  const fields = {
    assignedByUserId: trainer.userId,
    shareCode: newAssignmentShareCode(),
    status: "pending",
    assignedAt: new Date(),
    expiresAt: assignmentExpiresAt(),
  };
  const select = { id: true, assignedAt: true, shareCode: true } as const;
  const assignment = existing
    ? await db.rolePlayAssignment.update({ where: { id: existing.id }, data: { ...fields, usedAt: null }, select })
    : await db.rolePlayAssignment.create({ data: { ...fields, orgId: api.org.id, deploymentId: deployment.id, memberId: learner.memberId }, select });
  const url = practiceUrl(api.org.slug, assignment.shareCode);
  const emailSent = await emailAssignment({ org: api.org, idempotencyKey: `assignment:${assignment.id}:${assignment.shareCode}`, person: learner, scenario: agent, practiceUrl: url, trainerName: trainer.name });
  return Response.json({
    assignment: assignmentView(assignment, learner.email, learner.userId, agent.slug),
    created: true,
    practiceUrl: url,
    emailSent,
  }, { status: 201 });
}
