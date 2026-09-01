import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const createSchema = z.object({
  userId: z.string().min(1),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
}).strict();

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "assignments", "read");
  if (isApiError(api)) return api;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || undefined;
  const scenario = url.searchParams.get("scenario") || undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const where = {
    orgId: api.org.id,
    ...(userId ? { member: { userId } } : {}),
    ...(scenario ? { agent: { slug: scenario } } : {}),
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
        member: { select: { user: { select: { id: true, name: true, email: true } } } },
        agent: { select: { slug: true, name: true, version: true, visibility: true } },
      },
    }),
    db.rolePlayAssignment.count({ where }),
  ]);
  return Response.json({
    assignments: assignments.map(({ member, agent, ...assignment }) => ({
      ...assignment,
      user: member.user,
      scenario: agent,
    })),
    pagination: { limit, offset, total },
  });
}

export async function POST(request: Request) {
  const api = await requireExternalApi(request, "assignments", "write");
  if (isApiError(api)) return api;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "userId and a valid scenario slug are required" }, { status: 400 });

  const [member, agent, trainer] = await Promise.all([
    db.member.findFirst({
      where: { organizationId: api.org.id, userId: parsed.data.userId, role: "member" },
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
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
  if (!member) return Response.json({ error: "User not found" }, { status: 404 });
  if (!agent) return Response.json({ error: "Scenario not found" }, { status: 404 });
  if (!trainer) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });

  const existing = await db.rolePlayAssignment.findUnique({
    where: { agentId_memberId: { agentId: agent.id, memberId: member.id } },
    select: { id: true, assignedAt: true },
  });
  if (existing) return Response.json({ assignment: { ...existing, userId: parsed.data.userId, scenario: agent.slug }, created: false });

  const assignment = await db.rolePlayAssignment.create({
    data: {
      orgId: api.org.id,
      agentId: agent.id,
      memberId: member.id,
      assignedByUserId: trainer.userId,
    },
    select: { id: true, assignedAt: true },
  });
  const data = agent.data as { objective?: unknown } | null;
  const delivery = await sendRolePlayAssignmentEmail({
    to: member.user.email,
    userName: member.user.name,
    rolePlayName: agent.name,
    rolePlayObjective: typeof data?.objective === "string" ? data.objective : undefined,
    practiceUrl: `https://${api.org.slug}.${BASE_DOMAIN}/session/${encodeURIComponent(agent.slug)}`,
    trainerName: trainer.user.name,
  });
  return Response.json({
    assignment: { ...assignment, userId: parsed.data.userId, scenario: agent.slug },
    created: true,
    emailSent: delivery.success,
  }, { status: 201 });
}
