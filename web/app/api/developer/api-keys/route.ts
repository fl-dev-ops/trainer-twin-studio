import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";

const createSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
const deleteSchema = z.object({ id: z.string().min(1) }).strict();

export async function GET() {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const keys = await db.apikey.findMany({
    where: { referenceId: trainer.id, configId: "default" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      start: true,
      enabled: true,
      expiresAt: true,
      lastRequest: true,
      createdAt: true,
    },
  });
  return Response.json({ keys });
}

export async function POST(request: Request) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter a key name of up to 60 characters" }, { status: 400 });

  const created = await auth.api.createApiKey({
    body: {
      name: parsed.data.name,
      organizationId: trainer.id,
      userId: trainer.user.id,
      metadata: { createdByUserId: trainer.user.id },
    },
  });
  return Response.json({
    key: created.key,
    record: {
      id: created.id,
      name: created.name,
      start: created.start,
      enabled: created.enabled,
      expiresAt: created.expiresAt,
      lastRequest: created.lastRequest,
      createdAt: created.createdAt,
    },
  }, { status: 201 });
}

export async function DELETE(request: Request) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Missing API key ID" }, { status: 400 });

  const removed = await db.apikey.deleteMany({
    where: { id: parsed.data.id, referenceId: trainer.id, configId: "default" },
  });
  if (!removed.count) return Response.json({ error: "API key not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
