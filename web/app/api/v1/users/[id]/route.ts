import { z } from "zod";
import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const updateSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "read");
  if (isApiError(api)) return api;
  const { id } = await params;
  const member = await db.member.findFirst({
    where: { organizationId: api.org.id, userId: id, role: "member" },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, emailVerified: true } },
    },
  });
  if (!member) return Response.json({ error: "User not found" }, { status: 404 });
  return Response.json({ user: { ...member.user, memberId: member.id, role: member.role, createdAt: member.createdAt } });
}

export async function PATCH(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "write");
  if (isApiError(api)) return api;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A name of up to 100 characters is required" }, { status: 400 });
  const { id } = await params;
  const member = await db.member.findFirst({
    where: { organizationId: api.org.id, userId: id, role: "member" },
    select: { id: true },
  });
  if (!member) return Response.json({ error: "User not found" }, { status: 404 });
  const user = await db.user.update({
    where: { id },
    data: { name: parsed.data.name },
    select: { id: true, name: true, email: true, emailVerified: true },
  });
  return Response.json({ user: { ...user, memberId: member.id, role: "member" } });
}

export async function DELETE(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "users", "write");
  if (isApiError(api)) return api;
  const { id } = await params;
  const removed = await db.member.deleteMany({
    where: { organizationId: api.org.id, userId: id, role: "member" },
  });
  if (!removed.count) return Response.json({ error: "User not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
