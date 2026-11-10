import { z } from "zod";
import { MinutesError } from "@/lib/minutes";
import { getTrainerOrg } from "@/lib/org";
import { runTwinAssign } from "@/lib/workflow-runs";
import { accessUntilSchema, findTwinAgent, listTwinAssignments, TwinAccessError, twinUrl, updateTwinAssignment } from "@/lib/twin-access";

export const runtime = "nodejs";

const assignSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(100),
  /** Legacy, ignored: minutes are per learner now (new people get their starting minutes from the org balance). */
  minutes: z.number().int().min(1).max(10_000).optional(),
  /** Optional end date (ISO); calls can't start after it. */
  accessUntil: accessUntilSchema,
}).strict();
const updateSchema = z.object({
  assignmentId: z.string().min(1),
  status: z.enum(["active", "revoked"]),
}).strict();

const failed = (error: unknown) => {
  if (error instanceof TwinAccessError || error instanceof MinutesError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
};

/** Who has access to this twin, with minutes used. Studio only (admin, team). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    const assignments = await listTwinAssignments(trainer.id, agent.id);
    return Response.json({ assignments: assignments.map(({ shareCode, ...row }) => ({ ...row, url: twinUrl(trainer.slug, shareCode) })) });
  } catch (error) {
    return failed(error);
  }
}

/** Assigns the twin to people by email (new people get their starting minutes), and emails them their link. */
export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = assignSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give a list of emails and an optional future accessUntil" }, { status: 400 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    // The assign-twin workflow (workflows/assign-twin.ts): starting credits, access, then the emails.
    return Response.json(await runTwinAssign({
      org: { id: trainer.id, slug: trainer.slug },
      by: { id: trainer.user.id, name: trainer.user.name },
      agent,
      emails: parsed.data.emails,
      accessUntil: parsed.data.accessUntil,
    }));
  } catch (error) {
    return failed(error);
  }
}

/** Revokes or restores one person's access (their minutes are managed on the person). */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give an assignmentId and a status" }, { status: 400 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    return Response.json({ assignment: await updateTwinAssignment({ orgId: trainer.id, agentId: agent.id, ...parsed.data }) });
  } catch (error) {
    return failed(error);
  }
}
