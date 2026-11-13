import { AppError, errorResponse, refusals } from "@/lib/errors";
import { inOtherOrgs, LEARNER, orgPerson } from "@/lib/org-people";
import { z } from "zod";
import { db } from "@/lib/db";
import { setMemberDisabled } from "@/lib/members";
import { API_LEARNER_ROLE, findOrgLearner, requireExternalApi, apiRoute } from "@/lib/external-api";
import { learnerBalance } from "@/lib/minutes";

const updateSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
type Params = { params: Promise<{ id: string }> };

async function handleGET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "read");
  const { id } = await params;
  const learner = await findOrgLearner(api.org.id, { id });
  if (!learner) return errorResponse(refusals.notFound());
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, email: true, emailVerified: true } });
  const credits = await learnerBalance(api.org.id, learner.email);
  return Response.json({ user: { ...user, memberId: learner.memberId, role: API_LEARNER_ROLE, createdAt: learner.addedAt,
    creditsGiven: credits.grantedSeconds / 60, creditsLeft: Math.max(0, credits.balanceSeconds) / 60 } });
}

async function handlePATCH(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "write");
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(refusals.invalidInput("A name of up to 100 characters is required"));
  const { id } = await params;
  const learner = await findOrgLearner(api.org.id, { id });
  if (!learner) return errorResponse(refusals.notFound());
  const select = { id: true, name: true, email: true, emailVerified: true } as const;
  const current = await db.user.findUniqueOrThrow({ where: { id }, select });
  // The same name again changes nothing; an account other orgs use too is the person's to rename (specs/api.md rule 5).
  if (current.name === parsed.data.name) return Response.json({ user: { ...current, memberId: learner.memberId, role: API_LEARNER_ROLE } });
  if (await inOtherOrgs(id, api.org.id)) {
    throw new AppError("account_shared", "This person's account is also used by another organization. They can change their name in Settings.", 409);
  }
  const user = await db.user.update({ where: { id }, data: { name: parsed.data.name }, select });
  return Response.json({ user: { ...user, memberId: learner.memberId, role: API_LEARNER_ROLE } });
}

async function handleDELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "write");
  const { id } = await params;
  // Never deleted: "remove" disables the learner (signed out, access revoked, history kept). Same 204 / 404 contract.
  // A learner already disabled is 204 again (a retry), which also ends any call still running (specs/api.md rule 4).
  const learner = await orgPerson(api.org.id, { userId: id });
  if (!learner || learner.role !== LEARNER) return errorResponse(refusals.notFound());
  await setMemberDisabled({ orgId: api.org.id, memberId: learner.memberId, actorUserId: api.actorUserId, disabled: true });
  return new Response(null, { status: 204 });
}

export const GET = apiRoute(handleGET);
export const PATCH = apiRoute(handlePATCH);
export const DELETE = apiRoute(handleDELETE);
