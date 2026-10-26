import { z } from "zod";
import { MemberError, setMemberDisabled } from "@/lib/members";
import { getTrainerOrg } from "@/lib/org";

export const runtime = "nodejs";

const schema = z.object({ disabled: z.boolean() }).strict();

/** Disables or re-enables a member of the caller's org. Studio only (admin, team). Members are never deleted. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { disabled: true | false }" }, { status: 400 });
  try {
    await setMemberDisabled({ orgId: trainer.id, memberId: (await params).id, actorUserId: trainer.user.id, disabled: parsed.data.disabled });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MemberError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
