import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentChanges } from "@/lib/assignments";
import { db } from "@/lib/db";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
import { attachAssignmentSession, revokeAssignedSession } from "@/lib/interview-sessions";
import { getTrainerOrg } from "@/lib/org";

const bodySchema = z.object({
  memberIds: z.array(z.string().min(1)).max(500),
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
      where: { orgId: trainer.id, agent: { slug } },
      select: { id: true, memberId: true, sessionId: true },
    }),
  ]);

  if (!agent) return Response.json({ error: "Published role play not found" }, { status: 404 });
  if (members.length !== requestedIds.length) {
    return Response.json({ error: "One or more learners are not members of this organization" }, { status: 400 });
  }

  const changes = assignmentChanges(existing.map(({ memberId }) => memberId), requestedIds);
  const removed = existing.filter(({ memberId }) => changes.removed.includes(memberId));
  await Promise.all(removed.map(({ sessionId }) => revokeAssignedSession(sessionId)));
  if (changes.removed.length) {
    await db.rolePlayAssignment.deleteMany({ where: { agentId: agent.id, memberId: { in: changes.removed } } });
  }

  const added = new Set(changes.added);
  const recipients = members.filter(({ id }) => added.has(id));
  const launches = new Map<string, string>();
  for (const member of recipients) {
    const assignment = await db.rolePlayAssignment.create({
      data: { orgId: trainer.id, agentId: agent.id, memberId: member.id, assignedByUserId: trainer.user.id },
      select: { id: true },
    });
    try {
      const session = await attachAssignmentSession(assignment.id, {
        orgId: trainer.id, userId: member.user.id, agentId: agent.id,
      });
      launches.set(member.id, `https://${trainer.slug}.${BASE_DOMAIN}/s/${session.shareCode}`);
    } catch (error) {
      await db.rolePlayAssignment.delete({ where: { id: assignment.id } });
      throw error;
    }
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
