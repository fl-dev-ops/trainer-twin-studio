import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
}).strict().refine((value) => value.email || value.userId, "email or userId is required");

function practiceUrl(orgSlug: string, shareCode: string) {
  return `https://${orgSlug}.${BASE_DOMAIN}/s/${shareCode}`;
}

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "assignments", "read");
  if (isApiError(api)) return api;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || undefined;
  const requestedEmail = url.searchParams.get("email")?.trim().toLowerCase() || undefined;
  const scenario = url.searchParams.get("scenario") || undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const user = userId
    ? await db.user.findUnique({ where: { id: userId }, select: { email: true } })
    : null;
  const recipientEmail = requestedEmail ?? user?.email;
  const where = {
    orgId: api.org.id,
    ...(recipientEmail ? { recipientEmail } : {}),
    ...(userId && !user ? { recipientEmail: "" } : {}),
    ...(scenario ? { deployment: { agent: { slug: scenario } } } : {}),
  };
  const [assignments, total] = await Promise.all([
    db.rolePlayAssignment.findMany({
      where,
      orderBy: { assignedAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        assignedAt: true,
        shareCode: true,
        status: true,
        recipientEmail: true,
        member: { select: { user: { select: { id: true, name: true, email: true } } } },
        deployment: { select: { agent: { select: { slug: true, name: true, version: true, visibility: true } } } },
      },
    }),
    db.rolePlayAssignment.count({ where }),
  ]);
  return Response.json({
    assignments: assignments.map(({ member, deployment, shareCode, ...assignment }) => ({
      ...assignment,
      user: member?.user ?? { id: null, name: null, email: assignment.recipientEmail },
      scenario: deployment.agent,
      practiceUrl: practiceUrl(api.org.slug, shareCode),
    })),
    pagination: { limit, offset, total },
  });
}

export async function POST(request: Request) {
  const api = await requireExternalApi(request, "assignments", "write");
  if (isApiError(api)) return api;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "email or userId and a valid scenario slug are required" }, { status: 400 });

  const [user, agent, trainer] = await Promise.all([
    parsed.data.userId
      ? db.user.findUnique({
          where: { id: parsed.data.userId },
          select: { id: true, name: true, email: true },
        })
      : null,
    db.agent.findFirst({
      where: { orgId: api.org.id, slug: parsed.data.scenario },
      select: { id: true, slug: true, name: true, version: true, data: true },
    }),
    db.member.findFirst({
      where: {
        organizationId: api.org.id,
        role: { in: ["owner", "admin"] },
        ...(api.actorUserId ? { userId: api.actorUserId } : {}),
      },
      select: { userId: true, user: { select: { name: true } } },
    }),
  ]);
  if (parsed.data.userId && !user) return Response.json({ error: "User not found" }, { status: 404 });
  if (!agent) return Response.json({ error: "Scenario not found" }, { status: 404 });
  if (!trainer) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });

  const recipientEmail = parsed.data.email ?? user?.email.toLowerCase();
  if (!recipientEmail) return Response.json({ error: "Email is required" }, { status: 400 });
  const deployment = await ensureDeployment(api.org.id, agent.id);
  const existing = await db.rolePlayAssignment.findFirst({
    // ponytail: dashboard/API requests are serialized; add a DB unique index if concurrent assignment creation appears.
    where: { deploymentId: deployment.id, recipientEmail },
    select: { id: true, assignedAt: true, shareCode: true, status: true },
  });
  if (existing) return Response.json({
    assignment: { ...existing, email: recipientEmail, userId: user?.id ?? null, scenario: agent.slug },
    practiceUrl: practiceUrl(api.org.slug, existing.shareCode),
    created: false,
  });

  const assignment = await db.rolePlayAssignment.create({
    data: {
      orgId: api.org.id,
      deploymentId: deployment.id,
      recipientEmail,
      assignedByUserId: trainer.userId,
      shareCode: newAssignmentShareCode(),
      expiresAt: assignmentExpiresAt(),
    },
    select: { id: true, assignedAt: true, shareCode: true },
  });
  const url = practiceUrl(api.org.slug, assignment.shareCode);
  const data = agent.data as { objective?: unknown } | null;
  const upload = contextUploadFromAgentData(agent.data);
  const requiredArtifact = upload.required && upload.prompt
    ? { label: upload.label, prompt: upload.prompt }
    : null;
  const delivery = await sendRolePlayAssignmentEmail({
    to: recipientEmail,
    userName: user?.name,
    rolePlayName: agent.name,
    rolePlayObjective: typeof data?.objective === "string" ? data.objective : undefined,
    practiceUrl: url,
    trainerName: trainer.user.name,
    requiredArtifact,
  });
  return Response.json({
    assignment: { id: assignment.id, assignedAt: assignment.assignedAt, email: recipientEmail, userId: user?.id ?? null, scenario: agent.slug },
    created: true,
    practiceUrl: url,
    emailSent: delivery.success,
  }, { status: 201 });
}
