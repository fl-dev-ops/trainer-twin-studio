import { z } from "zod";
import { db } from "@/lib/db";
import { activateInterviewRuntime } from "@/lib/session-activation";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const querySchema = z.object({
  status: z.enum(["assigned", "activating", "active", "completed", "abandoned", "failed", "revoked"]).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).strict();

const createSchema = z.object({
  userId: z.string().min(1),
  deploymentKey: z.string().min(1).optional(),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
  mode: z.enum(["chat", "voice"]).default("chat"),
  documentId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
}).strict().refine((value) => value.deploymentKey || value.scenario, "deploymentKey or scenario is required");

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "sessions", "read");
  if (isApiError(api)) return api;
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get("status") || undefined,
    userId: url.searchParams.get("userId") || undefined,
    scenario: url.searchParams.get("scenario") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  });
  if (!parsed.success) return Response.json({ error: "Invalid session filters" }, { status: 400 });
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const startedAtRange = [
    parsed.data.from ? { gte: new Date(parsed.data.from) } : {},
    parsed.data.to ? { lte: new Date(parsed.data.to) } : {},
  ].filter((range) => Object.keys(range).length > 0);
  const where = {
    orgId: api.org.id,
    deletedAt: null,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.userId ? { userId: parsed.data.userId } : {}),
    ...(parsed.data.scenario ? { agentSlug: parsed.data.scenario } : {}),
    ...(startedAtRange.length > 0 ? { startedAt: Object.assign({}, ...startedAtRange) } : {}),
  };
  const [sessions, total] = await Promise.all([
    db.interviewSession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        userId: true,
        personaSlug: true,
        personaVersion: true,
        agentSlug: true,
        agentVersion: true,
        domainSlug: true,
        domainVersion: true,
        status: true,
        mode: true,
        contextName: true,
        createdAt: true,
        startedAt: true,
        endedAt: true,
      },
    }),
    db.interviewSession.count({ where }),
  ]);
  return Response.json({ sessions, pagination: { limit, offset, total } });
}

export async function POST(request: Request) {
  const api = await requireExternalApi(request, "sessions", "write");
  if (isApiError(api)) return api;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "userId and deploymentKey or scenario are required" }, { status: 400 });
  const user = await db.user.findFirst({
    where: { id: parsed.data.userId, members: { some: { organizationId: api.org.id } } },
    select: { id: true, name: true },
  });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });
  try {
    const activation = await activateInterviewRuntime({
      orgId: api.org.id,
      userId: user.id,
      userName: user.name,
      deploymentKey: parsed.data.deploymentKey,
      agentSlug: parsed.data.scenario,
      contextId: parsed.data.documentId,
      mode: parsed.data.mode,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    if (!activation) return Response.json({ error: "Could not activate session" }, { status: 409 });
    return Response.json(activation, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Session activation failed" }, { status: 400 });
  }
}
