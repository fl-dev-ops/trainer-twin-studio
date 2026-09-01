import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { sendInvitationEmail } from "@/lib/email";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const createSchema = z.object({ email: z.string().trim().email().max(320) }).strict();

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "users", "read");
  if (isApiError(api)) return api;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const [members, total, invitations] = await Promise.all([
    db.member.findMany({
      where: { organizationId: api.org.id, role: "member" },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, emailVerified: true } },
      },
    }),
    db.member.count({ where: { organizationId: api.org.id, role: "member" } }),
    db.invitation.findMany({
      where: { organizationId: api.org.id, status: "pending" },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, status: true, expiresAt: true, createdAt: true },
    }),
  ]);

  return Response.json({
    users: members.map(({ id: memberId, user, ...member }) => ({ ...user, ...member, memberId })),
    invitations,
    pagination: { limit, offset, total },
  });
}

export async function POST(request: Request) {
  const api = await requireExternalApi(request, "users", "write");
  if (isApiError(api)) return api;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A valid email is required" }, { status: 400 });

  const email = parsed.data.email.toLowerCase();
  const existingMember = await db.member.findFirst({
    where: { organizationId: api.org.id, user: { email } },
    select: { id: true },
  });
  if (existingMember) return Response.json({ error: "User is already an organization member" }, { status: 409 });

  const inviter = await db.member.findFirst({
    where: {
      organizationId: api.org.id,
      role: { in: ["owner", "admin"] },
      ...(api.actorUserId ? { userId: api.actorUserId } : {}),
    },
    select: { userId: true, user: { select: { name: true } } },
  });
  if (!inviter) return Response.json({ error: "API key creator is no longer an organization trainer" }, { status: 403 });

  const existingInvitation = await db.invitation.findFirst({
    where: { organizationId: api.org.id, email, status: "pending" },
    select: { id: true },
  });
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const invitation = existingInvitation
    ? await db.invitation.update({
        where: { id: existingInvitation.id },
        data: { expiresAt, inviterId: inviter.userId },
      })
    : await db.invitation.create({
        data: {
          id: randomUUID(),
          organizationId: api.org.id,
          email,
          role: "member",
          status: "pending",
          expiresAt,
          inviterId: inviter.userId,
        },
      });
  const delivery = await sendInvitationEmail({
    to: email,
    organizationName: api.org.name,
    inviterName: inviter.user.name,
    inviteUrl: `https://auth.${BASE_DOMAIN}/invite?token=${invitation.id}`,
  });

  return Response.json({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    },
    emailSent: delivery.success,
  }, { status: existingInvitation ? 200 : 201 });
}
