import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentChanges, assignmentExpiresAt, MAX_ASSIGNMENT_RECIPIENTS, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
import { getTrainerOrg } from "@/lib/org";

const bodySchema = z.object({
  memberIds: z.array(z.string().min(1)).max(MAX_ASSIGNMENT_RECIPIENTS),
}).strict();

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid member list" }, { status: 400 });

  const { slug } = await params;
  const requestedIds = [...new Set(parsed.data.memberIds)];
  const [agent, members, existing] = await Promise.all([
    db.agent.findFirst({
      where: { slug, orgId: trainer.id },
      select: { id: true, name: true, data: true },
    }),
    db.member.findMany({
      where: { id: { in: requestedIds }, organizationId: trainer.id, role: "member" },
      select: { id: true, user: { select: { id: true, name: true, email: true } } },
    }),
    db.rolePlayAssignment.findMany({
      where: { orgId: trainer.id, deployment: { agent: { slug } } },
      select: { id: true, memberId: true, status: true },
    }),
  ]);

  if (!agent) return Response.json({ error: "Published role play not found" }, { status: 404 });
  if (members.length !== requestedIds.length) {
    return Response.json({ error: "One or more learners are not members of this organization" }, { status: 400 });
  }

  const deployment = await ensureDeployment(trainer.id, agent.id);
  const changes = assignmentChanges(existing.map(({ memberId }) => memberId), requestedIds);
  const removed = existing.filter(({ memberId }) => changes.removed.includes(memberId));
  if (removed.length) {
    await db.rolePlayAssignment.updateMany({
      where: { id: { in: removed.map(({ id }) => id) }, status: "pending" },
      data: { status: "cancelled" },
    });
    await db.rolePlayAssignment.deleteMany({
      where: { id: { in: removed.map(({ id }) => id) }, status: { in: ["pending", "cancelled", "expired"] } },
    });
  }

  const added = new Set(changes.added);
  const recipients = members.filter(({ id }) => added.has(id));
  const launches = new Map<string, string>();
  for (const member of recipients) {
    const assignment = await db.rolePlayAssignment.create({
      data: {
        orgId: trainer.id,
        deploymentId: deployment.id,
        memberId: member.id,
        assignedByUserId: trainer.user.id,
        shareCode: newAssignmentShareCode(),
        expiresAt: assignmentExpiresAt(),
      },
      select: { shareCode: true },
    });
    launches.set(member.id, `https://${trainer.slug}.${BASE_DOMAIN}/s/${assignment.shareCode}`);
  }

  const data = agent.data as { objective?: unknown } | null;
  const objective = typeof data?.objective === "string" ? data.objective : undefined;
  const emailResults = await Promise.all(
    recipients.map(({ id, user }) => sendRolePlayAssignmentEmail({
      to: user.email,
      userName: user.name,
      rolePlayName: agent.name,
      rolePlayObjective: objective,
      practiceUrl: launches.get(id)!,
      trainerName: trainer.user.name,
    })),
  );
  const emailsSent = emailResults.filter(({ success }) => success).length;

  return Response.json({
    memberIds: changes.requested,
    added: changes.added.length,
    removed: changes.removed.length,
    emailsSent,
    emailFailures: emailResults.length - emailsSent,
  });
}
