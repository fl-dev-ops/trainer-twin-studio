import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentChanges } from "@/lib/assignments";
import { db } from "@/lib/db";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
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
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
    db.rolePlayAssignment.findMany({
      where: { orgId: trainer.id, agent: { slug } },
      select: { memberId: true },
    }),
  ]);

  if (!agent) return Response.json({ error: "Published role play not found" }, { status: 404 });
  if (members.length !== requestedIds.length) {
    return Response.json({ error: "One or more learners are not members of this organization" }, { status: 400 });
  }

  const changes = assignmentChanges(existing.map(({ memberId }) => memberId), requestedIds);
  await db.$transaction(async (tx) => {
    if (changes.removed.length) {
      await tx.rolePlayAssignment.deleteMany({
        where: { agentId: agent.id, memberId: { in: changes.removed } },
      });
    }
    if (changes.added.length) {
      await tx.rolePlayAssignment.createMany({
        data: changes.added.map((memberId) => ({
          orgId: trainer.id,
          agentId: agent.id,
          memberId,
          assignedByUserId: trainer.user.id,
        })),
        skipDuplicates: true,
      });
    }
  });

  const data = agent.data as { objective?: unknown } | null;
  const objective = typeof data?.objective === "string" ? data.objective : undefined;
  const added = new Set(changes.added);
  const recipients = members.filter(({ id }) => added.has(id));
  const practiceUrl = `https://${trainer.slug}.${BASE_DOMAIN}/session/${encodeURIComponent(slug)}`;
  const emailResults = await Promise.all(
    recipients.map(({ user }) => sendRolePlayAssignmentEmail({
      to: user.email,
      userName: user.name,
      rolePlayName: agent.name,
      rolePlayObjective: objective,
      practiceUrl,
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
