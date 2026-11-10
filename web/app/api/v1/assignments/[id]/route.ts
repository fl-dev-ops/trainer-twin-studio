import { z } from "zod";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { findOrgLearner, isApiError, requireExternalApi } from "@/lib/external-api";
import { giveStartingMinutes, MinutesError } from "@/lib/minutes";
import {
  assignmentDetails,
  assignmentDetailSelect,
  assignmentView,
  emailAssignment,
  findKeyTrainer,
  findScenario,
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
    select: { recipientEmail: true, deploymentId: true, assignedAt: true, shareCode: true, deployment: { select: { agent: { select: { id: true, slug: true, name: true, data: true } } } } },
  });
  if (!current) return Response.json({ error: "Assignment not found" }, { status: 404 });

  const [user, target, trainer] = await Promise.all([
    parsed.data.userId ? findOrgLearner(api.org.id, { id: parsed.data.userId }) : null,
    parsed.data.scenario ? findScenario(api.org.id, parsed.data.scenario) : current.deployment.agent,
    findKeyTrainer(api.org.id, api.actorUserId),
  ]);
  if (parsed.data.userId && !user) return Response.json({ error: "User not found" }, { status: 404 });
  if (!target) return Response.json({ error: "Scenario not found" }, { status: 404 });
  if (!trainer) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });
  const recipientEmail = parsed.data.email ?? user?.email.toLowerCase() ?? current.recipientEmail;
  const learner = user ?? await findOrgLearner(api.org.id, { email: recipientEmail });
  const deployment = await ensureDeployment(api.org.id, target.id);
  if (recipientEmail === current.recipientEmail && deployment.id === current.deploymentId) {
    return Response.json({
      assignment: assignmentView({ id, assignedAt: current.assignedAt }, recipientEmail, learner?.id ?? null, target.slug),
      practiceUrl: practiceUrl(api.org.slug, current.shareCode),
      changed: false,
    });
  }
  // One assignment per learner and scenario: moving onto a pair that already exists would make a second one.
  const clash = await db.rolePlayAssignment.findFirst({ where: { deploymentId: deployment.id, recipientEmail, id: { not: id } }, select: { id: true } });
  if (clash) return Response.json({ error: "That learner already has this scenario assigned" }, { status: 409 });
  // Moved to someone new to the org's credits: they get their starting credits first, as POST does.
  try {
    await giveStartingMinutes({ orgId: api.org.id, emails: [recipientEmail], actorUserId: trainer.userId });
  } catch (error) {
    if (error instanceof MinutesError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }

  // The old link stops working: the assignment gets a fresh code, recipient and expiry.
  const assignment = await db.rolePlayAssignment.update({
    where: { id },
    data: {
      memberId: null,
      recipientEmail,
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
  const emailSent = await emailAssignment({ orgId: api.org.id, idempotencyKey: `assignment:${assignment.id}:${assignment.shareCode}`, to: recipientEmail, userName: learner?.name, scenario: target, practiceUrl: url, trainerName: trainer.user.name });
  return Response.json({
    assignment: assignmentView(assignment, recipientEmail, learner?.id ?? null, target.slug),
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
