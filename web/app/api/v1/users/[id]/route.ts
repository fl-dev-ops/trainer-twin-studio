import { z } from "zod";
import { db } from "@/lib/db";
import { setMemberDisabled } from "@/lib/members";
import { API_LEARNER_ROLE, findOrgLearner, isApiError, requireExternalApi } from "@/lib/external-api";

const updateSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "read");
  if (isApiError(api)) return api;
  const { id } = await params;
  const learner = await findOrgLearner(api.org.id, { id });
  if (!learner) return Response.json({ error: "User not found" }, { status: 404 });
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, email: true, emailVerified: true } });
  return Response.json({ user: { ...user, memberId: learner.memberId, role: API_LEARNER_ROLE, createdAt: learner.addedAt } });
}

export async function PATCH(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "write");
  if (isApiError(api)) return api;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A name of up to 100 characters is required" }, { status: 400 });
  const { id } = await params;
  const learner = await findOrgLearner(api.org.id, { id });
  if (!learner) return Response.json({ error: "User not found" }, { status: 404 });
  const user = await db.user.update({
    where: { id },
    data: { name: parsed.data.name },
    select: { id: true, name: true, email: true, emailVerified: true },
  });
  return Response.json({ user: { ...user, memberId: learner.memberId, role: API_LEARNER_ROLE } });
}

export async function DELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "write");
  if (isApiError(api)) return api;
  const { id } = await params;
  // Never deleted: "remove" disables the learner (signed out, access revoked, history kept). Same 204 / 404 contract.
  const learner = await findOrgLearner(api.org.id, { id });
  if (!learner) return Response.json({ error: "User not found" }, { status: 404 });
  await setMemberDisabled({ orgId: api.org.id, memberId: learner.memberId, actorUserId: api.actorUserId ?? "", disabled: true });
  return new Response(null, { status: 204 });
}
