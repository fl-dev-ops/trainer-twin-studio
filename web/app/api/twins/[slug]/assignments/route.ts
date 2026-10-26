import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { sendTwinAssignmentEmail } from "@/lib/email";
import { getTrainerOrg } from "@/lib/org";
import { homeOrgsByEmail } from "@/lib/org-lock";
import { assignTwin, findTwinAgent, listTwinAssignments, TwinAccessError, updateTwinAssignment } from "@/lib/twin-access";

export const runtime = "nodejs";

const minutes = z.number().int().min(1).max(10_000);
const assignSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(100),
  minutes,
}).strict();
const updateSchema = z.object({
  assignmentId: z.string().min(1),
  minutesLimit: minutes.optional(),
  status: z.enum(["active", "revoked"]).optional(),
}).strict().refine((body) => body.minutesLimit !== undefined || body.status !== undefined, "Nothing to change");

const failed = (error: unknown) => {
  if (error instanceof TwinAccessError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
};

/** Who has access to this twin, with minutes used. Studio only (admin, team). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    const assignments = await listTwinAssignments(trainer.id, agent.id);
    return Response.json({
      assignments: assignments.map(({ shareCode, ...row }) => ({ ...row, url: `https://${trainer.slug}.${BASE_DOMAIN}/s/${shareCode}` })),
    });
  } catch (error) {
    return failed(error);
  }
}

/** Assigns the twin to people by email with a minutes budget each, and emails them their link. */
export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = assignSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give a list of emails and the minutes for each person" }, { status: 400 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    const { stats, invites } = await assignTwin({
      orgId: trainer.id,
      agentId: agent.id,
      emails: parsed.data.emails,
      minutes: parsed.data.minutes,
      assignedByUserId: trainer.user.id,
      homeOrgs: await homeOrgsByEmail(parsed.data.emails),
    });
    const deliveries = await Promise.all(invites.map(({ to, shareCode }) => sendTwinAssignmentEmail({
      to,
      twinName: agent.name,
      minutes: parsed.data.minutes,
      practiceUrl: `https://${trainer.slug}.${BASE_DOMAIN}/s/${shareCode}`,
      trainerName: trainer.user.name,
    })));
    return Response.json({ ...stats, emailFailures: deliveries.filter(({ success }) => !success).length });
  } catch (error) {
    return failed(error);
  }
}

/** Changes one person's minutes, or revokes / restores their access. */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give an assignmentId and new minutes or status" }, { status: 400 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    return Response.json({ assignment: await updateTwinAssignment({ orgId: trainer.id, agentId: agent.id, ...parsed.data }) });
  } catch (error) {
    return failed(error);
  }
}
