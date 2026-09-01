import { z } from "zod";
import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const querySchema = z.object({
  status: z.enum(["active", "completed", "abandoned"]).optional(),
  userId: z.string().min(1).optional(),
  scenario: z.string().min(1).optional(),
}).strict();

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "sessions", "read");
  if (isApiError(api)) return api;
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get("status") || undefined,
    userId: url.searchParams.get("userId") || undefined,
    scenario: url.searchParams.get("scenario") || undefined,
  });
  if (!parsed.success) return Response.json({ error: "Invalid session filters" }, { status: 400 });
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const where = {
    orgId: api.org.id,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.userId ? { userId: parsed.data.userId } : {}),
    ...(parsed.data.scenario ? { agentSlug: parsed.data.scenario } : {}),
  };
  const [sessions, total] = await Promise.all([
    db.interviewSession.findMany({
      where,
      orderBy: { startedAt: "desc" },
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
        contextName: true,
        startedAt: true,
        endedAt: true,
      },
    }),
    db.interviewSession.count({ where }),
  ]);
  return Response.json({ sessions, pagination: { limit, offset, total } });
}
