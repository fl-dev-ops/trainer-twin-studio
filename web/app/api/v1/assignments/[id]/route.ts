import { z } from "zod";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { isApiError, requireExternalApi } from "@/lib/external-api";
import { MinutesError } from "@/lib/minutes";
import { PeopleError } from "@/lib/org-people";
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

const updateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
}).strict().refine((value) => value.email || value.userId || value.scenario, "No changes supplied");
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "read");
  if (isApiError(api)) return api;
  const { id } = await params;
  const row = await db.rolePlayAssignment.findFirst({ where: { id, orgId: api.org.id }, select: assignmentDetailSelect });
  if (!row) return Response.json({ error: "Assignment not found" }, { status: 404 });
  const [assignment] = await assignmentDetails(api.org.id, api.org.slug, [row]);
  return Response.json({ assignment });
}

export async function PATCH(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "write");
  if (isApiError(api)) return api;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Supply an email, userId, or scenario" }, { status: 400 });
  const { id } = await params;
  const current = await db.rolePlayAssignment.findFirst({
    where: { id, orgId: api.org.id },
    select: { memberId: true, deploymentId: true, assignedAt: true, shareCode: true, member: { select: { userId: true, user: { select: { email: true } } } }, deployment: { select: { agent: { select: { id: true, slug: true, name: true, data: true } } } } },
  });
  if (!current) return Response.json({ error: "Assignment not found" }, { status: 404 });

  const [target, trainer] = await Promise.all([
    parsed.data.scenario ? findScenario(api.org.id, parsed.data.scenario) : current.deployment.agent,
    findKeyTrainer(api.org.id, api.actorUserId),
  ]);
  if (!target) return Response.json({ error: "Scenario not found" }, { status: 404 });
  if (!trainer) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });
  // The learner: unchanged, an existing one by userId, or by email (added to the org first when new).
  let learner;
  try {
    learner = await learnerFor(
      api.org.id,
      parsed.data.email || parsed.data.userId ? { email: parsed.data.email, userId: parsed.data.userId } : { userId: current.member.userId },
      trainer.userId,
    );
  } catch (error) {
    if (error instanceof PeopleError || error instanceof MinutesError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
  if (!learner) return Response.json({ error: "User not found" }, { status: 404 });
  const deployment = await ensureDeployment(api.org.id, target.id);
  if (learner.memberId === current.memberId && deployment.id === current.deploymentId) {
    return Response.json({
      assignment: assignmentView({ id, assignedAt: current.assignedAt }, learner.email, learner.userId, target.slug),
      practiceUrl: practiceUrl(api.org.slug, current.shareCode),
      changed: false,
    });
  }
  // One assignment per learner and scenario: moving onto a pair that already exists would make a second one.
  const clash = await db.rolePlayAssignment.findFirst({ where: { deploymentId: deployment.id, memberId: learner.memberId, id: { not: id } }, select: { id: true } });
  if (clash) return Response.json({ error: "That learner already has this scenario assigned" }, { status: 409 });

  // The old link stops working: the assignment gets a fresh code, recipient and expiry.
  const assignment = await db.rolePlayAssignment.update({
    where: { id },
    data: {
      memberId: learner.memberId,
      deploymentId: deployment.id,
      assignedByUserId: trainer.userId,
      assignedAt: new Date(),
      shareCode: newAssignmentShareCode(),
      status: "pending",
      usedAt: null,
      expiresAt: assignmentExpiresAt(),
    },
    select: { id: true, assignedAt: true, shareCode: true },
  });
  const url = practiceUrl(api.org.slug, assignment.shareCode);
  const emailSent = await emailAssignment({ org: api.org, idempotencyKey: `assignment:${assignment.id}:${assignment.shareCode}`, person: learner, scenario: target, practiceUrl: url, trainerName: trainer.name });
  return Response.json({
    assignment: assignmentView(assignment, learner.email, learner.userId, target.slug),
    practiceUrl: url,
    changed: true,
    emailSent,
  });
}

export async function DELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "write");
  if (isApiError(api)) return api;
  const { id } = await params;
  const removed = await db.rolePlayAssignment.deleteMany({ where: { id, orgId: api.org.id } });
  if (!removed.count) return Response.json({ error: "Assignment not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
