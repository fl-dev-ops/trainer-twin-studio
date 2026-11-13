import { z } from "zod";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { findOrgLearner, paginationFromUrl, requireExternalApi, apiRoute } from "@/lib/external-api";
import {
  assignmentDetails,
  assignmentDetailSelect,
  assignmentView,
  emailAssignment,
  findScenario,
  assignScenario,
  practiceUrl,
} from "@/lib/external-api-assignments";

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
}).strict().refine((value) => Boolean(value.email) !== Boolean(value.userId), "Supply either email or userId, not both.");

async function handleGET(request: Request) {
  const api = await requireExternalApi(request, "assignments", "read");
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || undefined;
  const requestedEmail = url.searchParams.get("email")?.trim().toLowerCase() || undefined;
  const scenario = url.searchParams.get("scenario") || undefined;
  if (userId && requestedEmail) throw refusals.invalidInput("Supply either email or userId, not both.");
  if (requestedEmail && !z.email().safeParse(requestedEmail).success) throw refusals.invalidInput("A valid email filter is required.");
  const page = paginationFromUrl(url);
  // A learner outside the org (or unknown) matches nothing.
  const learner = requestedEmail ? await findOrgLearner(api.org.id, { email: requestedEmail })
    : userId ? await findOrgLearner(api.org.id, { id: userId }) : null;
  const where = {
    orgId: api.org.id,
    ...(requestedEmail || userId ? { memberId: learner?.memberId ?? "" } : {}),
    ...(scenario ? { deployment: { agent: { slug: scenario } } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.rolePlayAssignment.findMany({ where, orderBy: [{ assignedAt: "desc" }, { id: "desc" }], skip: page.offset, take: page.limit, select: assignmentDetailSelect }),
    db.rolePlayAssignment.count({ where }),
  ]);
  return Response.json({ assignments: await assignmentDetails(api.org.id, api.org.slug, rows), pagination: { ...page, total } });
}

async function handlePOST(request: Request) {
  const api = await requireExternalApi(request, "assignments", "write");
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(refusals.invalidInput("Supply either email or userId (not both), and a valid scenario slug."));

  const agent = await findScenario(api.org.id, parsed.data.scenario);
  const trainer = api.trainer;
  if (!agent) return errorResponse(refusals.notFound());

  // The learner (by email, added to the org when new) and their link, in one locked transaction (practice rule 19).
  const deployment = await ensureDeployment(api.org.id, agent.id);
  let result;
  try {
    result = await assignScenario({ orgId: api.org.id, by: { email: parsed.data.email, userId: parsed.data.userId }, deploymentId: deployment.id, trainerUserId: trainer.userId });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    throw error;
  }
  if (!result) return errorResponse(refusals.notFound());
  const { person: learner, assignment, created } = result;
  // Idempotent: an open link is returned as it is, with no second email.
  if (!created) {
    return Response.json({
      assignment: assignmentView(assignment, learner.email, learner.userId, agent.slug),
      practiceUrl: practiceUrl(api.org.slug, assignment.shareCode),
      created: false,
    });
  }
  const url = practiceUrl(api.org.slug, assignment.shareCode);
  const emailSent = await emailAssignment({ org: api.org, idempotencyKey: `assignment:${assignment.id}:${assignment.shareCode}`, person: learner, scenario: agent, practiceUrl: url, trainerName: trainer.name });
  return Response.json({
    assignment: assignmentView(assignment, learner.email, learner.userId, agent.slug),
    created: true,
    practiceUrl: url,
    emailSent,
  }, { status: 201 });
}

export const GET = apiRoute(handleGET);
export const POST = apiRoute(handlePOST);
