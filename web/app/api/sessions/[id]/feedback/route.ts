import { z } from "zod";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  note: z.string().trim().max(500),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = feedbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid feedback" }, { status: 400 });

  const { id } = await params;
  const updated = await db.interviewSession.updateMany({
    where: { id, orgId: org.id, userId: user.id, status: { in: ["completed", "abandoned"] } },
    data: { feedbackRating: parsed.data.rating, feedbackNote: parsed.data.note || null },
  });
  if (!updated.count) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ ok: true });
}
