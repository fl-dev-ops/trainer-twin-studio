import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const updateSchema = z.object({
  userId: z.string().min(1).optional(),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
}).strict().refine((value) => value.userId || value.scenario, "No changes supplied");
type Params = { params: Promise<{ id: string }> };

function practiceUrl(orgSlug: string, shareCode: string) {
  return `https://${orgSlug}.${BASE_DOMAIN}/s/${shareCode}`;
}

export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "read");
  if (isApiError(api)) return api;
  const { id } = await params;
  const assignment = await db.rolePlayAssignment.findFirst({
    where: { id, orgId: api.org.id },
    select: {
      id: true,
      assignedAt: true,
      shareCode: true,
      status: true,
      member: { select: { user: { select: { id: true, name: true, email: true } } } },
      deployment: { select: { agent: { select: { slug: true, name: true, version: true, visibility: true } } } },
    },
  });
  if (!assignment) return Response.json({ error: "Assignment not found" }, { status: 404 });
  return Response.json({
    assignment: {
      id: assignment.id,
      assignedAt: assignment.assignedAt,
      status: assignment.status,
      user: assignment.member.user,
      scenario: assignment.deployment.agent,
      practiceUrl: practiceUrl(api.org.slug, assignment.shareCode),
    },
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "write");
  if (isApiError(api)) return api;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Supply a userId or scenario" }, { status: 400 });
  const { id } = await params;
  const current = await db.rolePlayAssignment.findFirst({
    where: { id, orgId: api.org.id },
    select: { memberId: true, deploymentId: true, assignedAt: true, shareCode: true, status: true },
  });
  if (!current) return Response.json({ error: "Assignment not found" }, { status: 404 });

  const [member, agent, trainer] = await Promise.all([
    parsed.data.userId
      ? db.member.findFirst({
          where: { organizationId: api.org.id, userId: parsed.data.userId, role: "member" },
          select: { id: true, user: { select: { id: true, name: true, email: true } } },
        })
      : db.member.findUnique({
          where: { id: current.memberId },
          select: { id: true, user: { select: { id: true, name: true, email: true } } },
        }),
    parsed.data.scenario
      ? db.agent.findFirst({
          where: { orgId: api.org.id, slug: parsed.data.scenario },
          select: { id: true, slug: true, name: true, version: true, data: true },
        })
      : db.agent.findFirst({
          where: { deployments: { some: { id: current.deploymentId } } },
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
  if (!member) return Response.json({ error: "User not found" }, { status: 404 });
  if (!agent) return Response.json({ error: "Scenario not found" }, { status: 404 });
  if (!trainer) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });
  const deployment = await ensureDeployment(api.org.id, agent.id);
  if (member.id === current.memberId && deployment.id === current.deploymentId) {
    return Response.json({
      assignment: { id, assignedAt: current.assignedAt, userId: member.user.id, scenario: agent.slug },
      practiceUrl: practiceUrl(api.org.slug, current.shareCode),
      changed: false,
    });
  }

  try {
    if (current.status === "pending") {
      await db.rolePlayAssignment.update({ where: { id }, data: { status: "cancelled" } });
    }
    const assignment = await db.rolePlayAssignment.update({
      where: { id },
      data: {
        memberId: member.id,
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
    const data = agent.data as { objective?: unknown } | null;
    const upload = contextUploadFromAgentData(agent.data);
    const requiredArtifact = upload.required && upload.prompt
      ? { label: upload.label, prompt: upload.prompt }
      : null;
    const delivery = await sendRolePlayAssignmentEmail({
      to: member.user.email,
      userName: member.user.name,
      rolePlayName: agent.name,
      rolePlayObjective: typeof data?.objective === "string" ? data.objective : undefined,
      practiceUrl: url,
      trainerName: trainer.user.name,
      requiredArtifact,
    });
    return Response.json({
      assignment: { ...assignment, userId: member.user.id, scenario: agent.slug },
      practiceUrl: url,
      changed: true,
      emailSent: delivery.success,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return Response.json({ error: "That user already has this scenario assigned" }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "assignments", "write");
  if (isApiError(api)) return api;
  const { id } = await params;
  const assignment = await db.rolePlayAssignment.findFirst({ where: { id, orgId: api.org.id }, select: { status: true } });
  if (!assignment) return Response.json({ error: "Assignment not found" }, { status: 404 });
  if (assignment.status === "pending") {
    await db.rolePlayAssignment.update({ where: { id }, data: { status: "cancelled" } });
  }
  await db.rolePlayAssignment.delete({ where: { id } });
  return new Response(null, { status: 204 });
}
