import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { assignmentExpiresAt, MAX_ASSIGNMENT_RECIPIENTS, newAssignmentShareCode } from "@/lib/assignments";
import { db } from "@/lib/db";
import { ensureDeployment } from "@/lib/deployments";
import { sendRolePlayAssignmentEmail } from "@/lib/email";
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
  const agent = await db.agent.findFirst({
    where: { slug, orgId: trainer.id },
    select: { id: true, name: true, data: true },
  });
  if (!agent) return Response.json({ error: "Published role play not found" }, { status: 404 });

  const deployment = await ensureDeployment(trainer.id, agent.id);
  const assignments = await db.rolePlayAssignment.findMany({
    where: { deploymentId: deployment.id, recipientEmail: { in: emails } },
    select: { id: true, recipientEmail: true, status: true, shareCode: true },
  });
  const assignmentByEmail = new Map(assignments.map((assignment) => [assignment.recipientEmail, assignment]));
  const stats = { added: 0, resent: 0, skipped: 0 };
  const assignmentEmails: Array<{ to: string; practiceUrl: string }> = [];

  for (const email of emails) {
    const existing = assignmentByEmail.get(email);
    if (!existing || existing.status === "cancelled" || existing.status === "expired") {
      const shareCode = newAssignmentShareCode();
      if (existing) {
        await db.rolePlayAssignment.update({
          where: { id: existing.id },
          data: {
            memberId: null,
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
            recipientEmail: email,
            assignedByUserId: trainer.user.id,
            shareCode,
            expiresAt: assignmentExpiresAt(),
          },
        });
      }
      stats.added++;
      assignmentEmails.push({
        to: email,
        practiceUrl: `https://${trainer.slug}.${BASE_DOMAIN}/s/${shareCode}`,
      });
    } else if (existing.status === "pending" && parsed.data.resendPending === "send") {
      stats.resent++;
      assignmentEmails.push({
        to: email,
        practiceUrl: `https://${trainer.slug}.${BASE_DOMAIN}/s/${existing.shareCode}`,
      });
    } else {
      stats.skipped++;
    }
  }

  const data = agent.data as { objective?: unknown } | null;
  const objective = typeof data?.objective === "string" ? data.objective : undefined;
  const upload = contextUploadFromAgentData(agent.data);
  const requiredArtifact = upload.required && upload.prompt
    ? { label: upload.label, prompt: upload.prompt }
    : null;
  const deliveries = await Promise.all(
    assignmentEmails.map(({ to, practiceUrl }) =>
      sendRolePlayAssignmentEmail({
        to,
        rolePlayName: agent.name,
        rolePlayObjective: objective,
        practiceUrl,
        trainerName: trainer.user.name,
        requiredArtifact,
      }),
    ),
  );

  return Response.json({
    ...stats,
    emailFailures: deliveries.filter(({ success }) => !success).length,
  });
}
