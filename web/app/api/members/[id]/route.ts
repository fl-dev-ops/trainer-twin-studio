import { z } from "zod";
import { errorResponse, refusals } from "@/lib/errors";
import { setMemberDisabled } from "@/lib/members";
import { studioOrg } from "@/lib/org";

export const runtime = "nodejs";

const schema = z.object({ disabled: z.boolean() }).strict();

/** Disables or re-enables a member of the caller's org. Studio only (admin, team). Members are never deleted. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const trainer = await studioOrg();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw refusals.invalidInput("Send { disabled: true | false }");
    await setMemberDisabled({ orgId: trainer.id, memberId: (await params).id, actorUserId: trainer.user.id, disabled: parsed.data.disabled });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
