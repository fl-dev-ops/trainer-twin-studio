import { removeRoleplayAssignment } from "@/lib/roleplay-access";
import { z } from "zod";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { requireExternalApi, apiRoute } from "@/lib/external-api";
import { errorResponse, refusals } from "@/lib/errors";
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
}).strict()
  .refine((value) => value.email || value.userId || value.scenario, "No changes supplied")
  .refine((value) => !(value.email && value.userId), "Supply either email or userId, not both.");
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
  if (!parsed.success) return errorResponse(refusals.invalidInput("Supply either email or userId (not both), and/or a valid scenario."));
  const { id } = await params;
  const current = await db.rolePlayAssignment.findFirst({
    where: { id, orgId: api.org.id },
    select: { member: { select: { userId: true } }, deployment: { select: { agent: { select: { id: true, slug: true, name: true, data: true } } } } },
  });
  if (!current) return errorResponse(refusals.notFound());

  const target = parsed.data.scenario ? await findScenario(api.org.id, parsed.data.scenario) : current.deployment.agent;
  const trainer = api.trainer;
  if (!target) return errorResponse(refusals.notFound());
  const deployment = await ensureDeployment(api.org.id, target.id);
  // Eligibility, no-op, move and retry are decided together under the shared locks, never on this earlier read.
  const result = await assignScenario({
    orgId: api.org.id,
    by: parsed.data.email ? { email: parsed.data.email } : { userId: parsed.data.userId ?? current.member.userId },
    deploymentId: deployment.id,
    trainerUserId: trainer.userId,
    moveFrom: id,
  });
  if (!result) return errorResponse(refusals.notFound());
  const { person: learner, assignment, created } = result;
  const url = practiceUrl(api.org.slug, assignment.shareCode);
  if (!created) return Response.json({ assignment: assignmentView(assignment, learner.email, learner.userId, target.slug), practiceUrl: url, changed: false });
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
  const removed = await removeRoleplayAssignment(api.org.id, id);
  if (!removed) return errorResponse(refusals.notFound());
  return new Response(null, { status: 204 });
}

export const GET = apiRoute(handleGET);
export const PATCH = apiRoute(handlePATCH);
export const DELETE = apiRoute(handleDELETE);
