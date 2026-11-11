import { z } from "zod";
import { MAX_ASSIGNMENT_RECIPIENTS } from "@/lib/assignments";
import { db } from "@/lib/db";
import { studioOrRefusal } from "@/lib/org";
import { AppError, errorResponse } from "@/lib/errors";
import { MAX_LEARNER_MINUTES } from "@/lib/minutes";
import { runRoleplayAssign } from "@/lib/workflow-runs";

const bodySchema = z.object({
  emails: z
    .array(z.string().trim().toLowerCase().email().max(320))
    .min(1)
    .max(MAX_ASSIGNMENT_RECIPIENTS),
  resendPending: z.enum(["send", "ignore"]).default("ignore"),
  /** Credits each new person starts with; people who already have credits keep theirs. */
  startingMinutes: z.number().int().min(1).max(MAX_LEARNER_MINUTES).optional(),
}).strict();

const deleteSchema = z.object({
  assignmentId: z.string().min(1),
}).strict();

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const trainer = await studioOrRefusal();
  if (trainer instanceof Response) return trainer;

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
  const trainer = await studioOrRefusal();
  if (trainer instanceof Response) return trainer;

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
    // The assign-roleplay workflow (workflows/assign-roleplay.ts): starting credits, links, then the emails.
    return Response.json(await runRoleplayAssign({
      org: { id: trainer.id, slug: trainer.slug },
      by: { id: trainer.user.id, name: trainer.user.name },
      agent,
      emails: parsed.data.emails,
      resendPending: parsed.data.resendPending === "send",
      startingMinutes: parsed.data.startingMinutes,
    }));
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    throw error;
  }
}
