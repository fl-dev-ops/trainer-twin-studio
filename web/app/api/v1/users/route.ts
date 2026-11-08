import { z } from "zod";
import { db } from "@/lib/db";
import { API_LEARNER_ROLE, isApiError, paginationFromUrl, requireExternalApi } from "@/lib/external-api";
import { InviteError, inviteLearnerByApi } from "@/lib/invite/org";
import { LEARNER_ROLE } from "@/lib/org";

const createSchema = z.object({ email: z.string().trim().email().max(320) }).strict();

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "users", "read");
  if (isApiError(api)) return api;
  const page = paginationFromUrl(new URL(request.url));
  if (page instanceof Response) return page;

  const [members, total, invitations] = await Promise.all([
    db.member.findMany({
      where: { organizationId: api.org.id, role: LEARNER_ROLE, disabledAt: null },
      orderBy: { createdAt: "desc" },
      skip: page.offset,
      take: page.limit,
      select: {
        id: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, emailVerified: true } },
      },
    }),
    db.member.count({ where: { organizationId: api.org.id, role: LEARNER_ROLE, disabledAt: null } }),
    db.invitation.findMany({
      // Learner invitations only: invitations to the studio team are not part of the learner API.
      where: { organizationId: api.org.id, status: "pending", role: LEARNER_ROLE },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, status: true, expiresAt: true, createdAt: true },
    }),
  ]);

  return Response.json({
    // Every listed member is a learner; the API calls that role `member` (API_LEARNER_ROLE).
    users: members.map(({ id: memberId, user, ...member }) => ({ ...user, ...member, role: API_LEARNER_ROLE, memberId })),
    invitations,
    pagination: { ...page, total },
  });
}

export async function POST(request: Request) {
  const api = await requireExternalApi(request, "users", "write");
  if (isApiError(api)) return api;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A valid email is required" }, { status: 400 });

  try {
    const { invitation, created, emailSent } = await inviteLearnerByApi({ org: api.org, actorUserId: api.actorUserId, email: parsed.data.email });
    return Response.json({
      invitation: { id: invitation.id, email: invitation.email, status: invitation.status, expiresAt: invitation.expiresAt },
      emailSent,
    }, { status: created ? 201 : 200 });
  } catch (error) {
    if (error instanceof InviteError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
