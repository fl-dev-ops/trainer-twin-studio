import { orgPerson } from "@/lib/org-people";
import { removableLink, roleplayRefusals } from "@/lib/roleplay-access";
import { z } from "zod";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { requireExternalApi, apiRoute } from "@/lib/external-api";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import {
  assignmentDetails,
  assignmentDetailSelect,
  assignmentView,
  emailAssignment,
  findScenario,
  assignScenario,
  practiceUrl,
} from "@/lib/external-api-assignments";

const updateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
}).strict().refine((value) => value.email || value.userId || value.scenario, "No changes supplied");
type Params = { params: Promise<{ id: string }> };

async function handleGET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "read");
  const { id } = await params;
  const row = await db.rolePlayAssignment.findFirst({ where: { id, orgId: api.org.id }, select: assignmentDetailSelect });
  if (!row) return errorResponse(refusals.notFound());
  const [assignment] = await assignmentDetails(api.org.id, api.org.slug, [row]);
  return Response.json({ assignment });
}

async function handlePATCH(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "write");
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(refusals.invalidInput("Supply an email, userId, or scenario"));
  const { id } = await params;
  const current = await db.rolePlayAssignment.findFirst({
    where: { id, orgId: api.org.id },
    select: { status: true, memberId: true, deploymentId: true, assignedAt: true, shareCode: true, member: { select: { userId: true, user: { select: { email: true } } } }, deployment: { select: { agent: { select: { id: true, slug: true, name: true, data: true } } } } },
  });
  if (!current) return errorResponse(refusals.notFound());

  const target = parsed.data.scenario ? await findScenario(api.org.id, parsed.data.scenario) : current.deployment.agent;
  const trainer = api.trainer;
  if (!target) return errorResponse(refusals.notFound());
  const deployment = await ensureDeployment(api.org.id, target.id);
  const sameLearner = (!parsed.data.email && !parsed.data.userId)
    || parsed.data.userId === current.member.userId
    || parsed.data.email?.trim().toLowerCase() === current.member.user.email.toLowerCase();
  // A link no longer open can't be moved; a retry of a move that already happened answers the learner's open link
  // for that role play unchanged (specs/api.md rule 4).
  if (!["pending", "used"].includes(current.status)) {
    const targetUser = sameLearner
      ? current.member.userId
      : (await orgPerson(api.org.id, parsed.data.userId ? { userId: parsed.data.userId } : { email: parsed.data.email! }))?.userId;
    const open = targetUser
      ? await db.rolePlayAssignment.findFirst({
          where: { orgId: api.org.id, deploymentId: deployment.id, member: { userId: targetUser }, status: { in: ["pending", "used"] } },
          select: { id: true, assignedAt: true, shareCode: true, member: { select: { userId: true, user: { select: { email: true } } } } },
        })
      : null;
    if (!open) throw roleplayRefusals.accessRemoved();
    return Response.json({
      assignment: assignmentView({ id: open.id, assignedAt: open.assignedAt }, open.member.user.email, open.member.userId, target.slug),
      practiceUrl: practiceUrl(api.org.slug, open.shareCode),
      changed: false,
    });
  }
  if (sameLearner && deployment.id === current.deploymentId) {
    return Response.json({
      assignment: assignmentView({ id, assignedAt: current.assignedAt }, current.member.user.email, current.member.userId, target.slug),
      practiceUrl: practiceUrl(api.org.slug, current.shareCode),
      changed: false,
    });
  }
  // A move (practice rule 19): the old link is cancelled (its calls stay with it) and a new one made for the target.
  let result;
  try {
    result = await assignScenario({
      orgId: api.org.id,
      by: sameLearner ? { userId: current.member.userId } : { email: parsed.data.email, userId: parsed.data.userId },
      deploymentId: deployment.id,
      trainerUserId: trainer.userId,
      moveFrom: id,
    });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    throw error;
  }
  if (!result) return errorResponse(refusals.notFound());
  const { person: learner, assignment } = result;
  const url = practiceUrl(api.org.slug, assignment.shareCode);
  const emailSent = await emailAssignment({ org: api.org, idempotencyKey: `assignment:${assignment.id}:${assignment.shareCode}`, person: learner, scenario: target, practiceUrl: url, trainerName: trainer.name });
  return Response.json({
    assignment: assignmentView(assignment, learner.email, learner.userId, target.slug),
    practiceUrl: url,
    changed: true,
    emailSent,
  });
}

async function handleDELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "write");
  const { id } = await params;
  // Like the dashboard: only a link nobody has practised on is removed (specs/api.md rule 4).
  const removed = await db.rolePlayAssignment.deleteMany({ where: { id, orgId: api.org.id, ...removableLink } });
  if (!removed.count) return errorResponse(refusals.notFound());
  return new Response(null, { status: 204 });
}

export const GET = apiRoute(handleGET);
export const PATCH = apiRoute(handlePATCH);
export const DELETE = apiRoute(handleDELETE);
