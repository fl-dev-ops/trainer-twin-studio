import { z } from "zod";
import { MAX_ASSIGNMENT_RECIPIENTS } from "@/lib/assignments";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { MinutesError } from "@/lib/minutes";
import { inviteToRoleplay } from "@/lib/roleplay/invites";

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
  const agent = await db.agent.findFirst({
    // Role-play invites are for role plays only; twins have their own assignments (/api/twins/[slug]/assignments).
    where: { slug, orgId: trainer.id, kind: "ROLEPLAY", archivedAt: null },
    select: { id: true, name: true, data: true },
  });
  if (!agent) return Response.json({ error: "Published role play not found" }, { status: 404 });

  try {
    return Response.json(await inviteToRoleplay({
      org: { id: trainer.id, slug: trainer.slug },
      by: { id: trainer.user.id, name: trainer.user.name },
      agent,
      emails: parsed.data.emails,
      resendPending: parsed.data.resendPending === "send",
    }));
  } catch (error) {
    if (error instanceof MinutesError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
