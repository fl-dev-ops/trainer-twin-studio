import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, MAX_ASSIGNMENT_RECIPIENTS, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { sendInvitationEmail, sendRolePlayAssignmentEmail } from "@/lib/email";
import { contextUploadFromAgentData } from "@/lib/context-upload";
import { getTrainerOrg } from "@/lib/org";

const bodySchema = z.object({
  emails: z
    .array(z.string().trim().toLowerCase().email().max(320))
    .min(1)
    .max(MAX_ASSIGNMENT_RECIPIENTS),
  resendPending: z.enum(["send", "ignore"]).default("ignore"),
}).strict();

const deleteSchema = z.object({
  assignmentId: z.string().min(1),
}).strict();

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const { slug } = await params;
  const assignment = await db.rolePlayAssignment.findFirst({
    where: {
      id: parsed.data.assignmentId,
      orgId: trainer.id,
      deployment: { agent: { slug } },
      status: "pending",
    },
    select: { id: true },
  });
  if (!assignment) {
    return Response.json({ error: "Pending assignment not found" }, { status: 404 });
  }

  await db.rolePlayAssignment.delete({ where: { id: assignment.id } });
  return Response.json({ removed: true });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid email list" }, { status: 400 });

  const { slug } = await params;
  const emails = [...new Set(parsed.data.emails)];
  const [agent, members, assignments, invitations, organization] = await Promise.all([
    db.agent.findFirst({
      where: { slug, orgId: trainer.id },
      select: { id: true, name: true, data: true },
    }),
    db.member.findMany({
      where: { organizationId: trainer.id, role: "member", user: { email: { in: emails } } },
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
    db.rolePlayAssignment.findMany({
      where: { orgId: trainer.id, deployment: { agent: { slug } } },
      select: { id: true, memberId: true, status: true, shareCode: true },
    }),
    db.invitation.findMany({
      where: { organizationId: trainer.id, status: "pending", email: { in: emails } },
      select: { id: true, email: true },
    }),
    db.organization.findUnique({ where: { id: trainer.id }, select: { name: true } }),
  ]);

  if (!agent) return Response.json({ error: "Published role play not found" }, { status: 404 });

  const deployment = await ensureDeployment(trainer.id, agent.id);
  const memberByEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m]));
  const assignmentByMemberId = new Map(assignments.map((a) => [a.memberId, a]));
  const invitationByEmail = new Map(invitations.map((i) => [i.email, i]));
  const invitationExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const stats = { added: 0, invited: 0, resent: 0, skipped: 0 };
  const assignmentEmails: Array<{ to: string; userName?: string; practiceUrl: string }> = [];
  const invitationEmails: Array<{ to: string; token: string }> = [];

  for (const email of emails) {
    const member = memberByEmail.get(email);
    if (member) {
      const existing = assignmentByMemberId.get(member.id);
      if (!existing || existing.status === "cancelled" || existing.status === "expired") {
        const shareCode = newAssignmentShareCode();
        if (existing) {
          await db.rolePlayAssignment.update({
            where: { id: existing.id },
            data: {
              shareCode,
              status: "pending",
              assignedAt: new Date(),
              expiresAt: assignmentExpiresAt(),
              usedAt: null,
            },
          });
        } else {
          await db.rolePlayAssignment.create({
            data: {
              orgId: trainer.id,
              deploymentId: deployment.id,
              memberId: member.id,
              assignedByUserId: trainer.user.id,
              shareCode,
              expiresAt: assignmentExpiresAt(),
            },
          });
        }
        stats.added++;
        assignmentEmails.push({
          to: email,
          userName: member.user.name,
          practiceUrl: `https://${trainer.slug}.${BASE_DOMAIN}/s/${shareCode}`,
        });
      } else if (existing.status === "pending" && parsed.data.resendPending === "send") {
        stats.resent++;
        assignmentEmails.push({
          to: email,
          userName: member.user.name,
          practiceUrl: `https://${trainer.slug}.${BASE_DOMAIN}/s/${existing.shareCode}`,
        });
      } else {
        stats.skipped++;
      }
    } else {
      const existingInvite = invitationByEmail.get(email);
      const invitation = existingInvite
        ? await db.invitation.update({
            where: { id: existingInvite.id },
            data: { expiresAt: invitationExpiresAt, inviterId: trainer.user.id },
          })
        : await db.invitation.create({
            data: {
              id: randomUUID(),
              organizationId: trainer.id,
              email,
              role: "member",
              status: "pending",
              expiresAt: invitationExpiresAt,
              inviterId: trainer.user.id,
            },
          });
      stats.invited++;
      invitationEmails.push({ to: email, token: invitation.id });
    }
  }

  const data = agent.data as { objective?: unknown } | null;
  const objective = typeof data?.objective === "string" ? data.objective : undefined;
  const upload = contextUploadFromAgentData(agent.data);
  const requiredArtifact = upload.required && upload.prompt
    ? { label: upload.label, prompt: upload.prompt }
    : null;

  const [assignmentResults, invitationResults] = await Promise.all([
    Promise.all(
      assignmentEmails.map(({ to, userName, practiceUrl }) =>
        sendRolePlayAssignmentEmail({
          to,
          userName,
          rolePlayName: agent.name,
          rolePlayObjective: objective,
          practiceUrl,
          trainerName: trainer.user.name,
          requiredArtifact,
        }),
      ),
    ),
    Promise.all(
      invitationEmails.map(({ to, token }) =>
        sendInvitationEmail({
          to,
          organizationName: organization?.name ?? "TrainerTwin",
          inviterName: trainer.user.name,
          inviteUrl: `https://auth.${BASE_DOMAIN}/invite?token=${token}`,
        }),
      ),
    ),
  ]);

  const deliveries = [...assignmentResults, ...invitationResults];
  const emailFailures = deliveries.filter(({ success }) => !success).length;

  return Response.json({
    added: stats.added,
    invited: stats.invited,
    resent: stats.resent,
    skipped: stats.skipped,
    emailFailures,
  });
}
