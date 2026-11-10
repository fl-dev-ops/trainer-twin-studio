import { z } from "zod";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { giveStartingMinutes, MinutesError } from "@/lib/minutes";
import { findOrgLearner, isApiError, paginationFromUrl, requireExternalApi } from "@/lib/external-api";
import {
  assignmentDetails,
  assignmentDetailSelect,
  assignmentView,
  emailAssignment,
  findKeyTrainer,
  findScenario,
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
  // A userId outside the org (or unknown) matches nothing.
  const learner = userId ? await findOrgLearner(api.org.id, { id: userId }) : null;
  const recipientEmail = requestedEmail ?? learner?.email.toLowerCase() ?? (userId ? "" : undefined);
  const where = {
    orgId: api.org.id,
    ...(recipientEmail !== undefined ? { recipientEmail } : {}),
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

  const [user, agent, trainer] = await Promise.all([
    parsed.data.userId ? findOrgLearner(api.org.id, { id: parsed.data.userId }) : null,
    findScenario(api.org.id, parsed.data.scenario),
    findKeyTrainer(api.org.id, api.actorUserId),
  ]);
  if (parsed.data.userId && !user) return Response.json({ error: "User not found" }, { status: 404 });
  if (!agent) return Response.json({ error: "Scenario not found" }, { status: 404 });
  if (!trainer) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });

  const recipientEmail = parsed.data.email ?? user!.email.toLowerCase();
  // With an email only, the learner is the org learner with that email, if they have joined.
  const learner = user ?? await findOrgLearner(api.org.id, { email: recipientEmail });
  const deployment = await ensureDeployment(api.org.id, agent.id);
  const existing = await db.rolePlayAssignment.findFirst({
    // ponytail: dashboard/API requests are serialized; add a DB unique index if concurrent assignment creation appears.
    where: { deploymentId: deployment.id, recipientEmail },
    select: { id: true, assignedAt: true, shareCode: true, status: true },
  });
  // Idempotent: a live assignment (pending or used) is returned as it is, with no second email.
  if (existing && (existing.status === "pending" || existing.status === "used")) {
    return Response.json({
      assignment: assignmentView(existing, recipientEmail, learner?.id ?? null, agent.slug),
      practiceUrl: practiceUrl(api.org.slug, existing.shareCode),
      created: false,
    });
  }

  // New, or a cancelled / expired one reopened with a fresh link (as the dashboard's Assign does). Someone new to the
  // org's minutes gets their starting minutes from its balance first.
  try {
    await giveStartingMinutes({ orgId: api.org.id, emails: [recipientEmail], actorUserId: trainer.userId });
  } catch (error) {
    if (error instanceof MinutesError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
  const fields = {
    assignedByUserId: trainer.userId,
    shareCode: newAssignmentShareCode(),
    status: "pending",
    assignedAt: new Date(),
    expiresAt: assignmentExpiresAt(),
  };
  const select = { id: true, assignedAt: true, shareCode: true } as const;
  const assignment = existing
    ? await db.rolePlayAssignment.update({ where: { id: existing.id }, data: { ...fields, memberId: null, usedAt: null }, select })
    : await db.rolePlayAssignment.create({ data: { ...fields, orgId: api.org.id, deploymentId: deployment.id, recipientEmail }, select });
  const url = practiceUrl(api.org.slug, assignment.shareCode);
  const emailSent = await emailAssignment({ orgId: api.org.id, idempotencyKey: `assignment:${assignment.id}:${assignment.shareCode}`, to: recipientEmail, userName: learner?.name, scenario: agent, practiceUrl: url, trainerName: trainer.user.name });
  return Response.json({
    assignment: assignmentView(assignment, recipientEmail, learner?.id ?? null, agent.slug),
    created: true,
    practiceUrl: url,
    emailSent,
  }, { status: 201 });
}
