import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { clientPersonaCard } from "@/lib/roleplay";
import { draftRoleplay, scenarioFromActivity, type AssistPersona } from "@/lib/roleplay-assistant";
import { isSessionReport } from "@/lib/session-report";

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("draft"), prompt: z.string().trim().min(3).max(4000) }).strict(),
  z.object({ mode: z.literal("scenario"), persona: z.string().max(120).optional() }).strict(),
]);

/** Builder assistant: fill the form from a description, or write a scenario from recent activity. */
export async function POST(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (org.type !== "SALES") return NextResponse.json({ error: "Role plays are for sales organizations" }, { status: 422 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Describe the situation first" }, { status: 400 });

  const rows = await db.persona.findMany({ where: { orgId: org.id }, select: { slug: true, data: true } });
  const personas: AssistPersona[] = rows.flatMap((row) => {
    const card = clientPersonaCard(row.slug, row.data);
    return card ? [{ slug: card.slug, name: card.name, role: card.role, background: card.background }] : [];
  });

  const input = parsed.data;
  try {
    if (input.mode === "draft") {
      return NextResponse.json({ draft: await draftRoleplay(input.prompt, personas) });
    }
    const persona = personas.find((item) => item.slug === input.persona) ?? null;
    const sessions = await db.interviewSession.findMany({
      where: { orgId: org.id, deletedAt: null, reportStatus: "completed" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { report: true },
    });
    const activity = sessions.flatMap((session) =>
      isSessionReport(session.report) ? [`${session.report.summary} Focus next time: ${session.report.focusNextTime}`] : [],
    );
    return NextResponse.json({ scenario: await scenarioFromActivity(persona, activity) });
  } catch (error) {
    console.error("Role-play assistant failed", error);
    return NextResponse.json({ error: "Could not draft that right now. Try again in a moment." }, { status: 502 });
  }
}
