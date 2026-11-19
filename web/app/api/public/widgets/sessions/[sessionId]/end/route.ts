import { AppError, errorResponse, refusals } from "@/lib/errors";
import { db } from "@/lib/db";
import { widgetBearer, widgetRequestOrg } from "@/lib/widget-access";
import { readWidgetEnd, widgetCredentialInvalid } from "@/lib/widget-tokens";
import { browserToken } from "@/lib/interview-sessions";
import { endPublicTwinSession } from "@/lib/public-twin-sessions";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const org = await widgetRequestOrg(request);
    const { sessionId } = await context.params;
    const capability = readWidgetEnd(widgetBearer(request));
    if (capability.orgId !== org.id || capability.sessionId !== sessionId) throw widgetCredentialInvalid();
    const session = await db.interviewSession.findFirst({
      where: { id: sessionId, orgId: org.id, agentId: capability.agentId, anonymousId: capability.visitorId, embedOrigin: capability.parentOrigin },
      select: { id: true },
    });
    if (!session) throw refusals.notFound();
    await endPublicTwinSession({ sessionId, orgId: org.id, visitorId: capability.visitorId, token: browserToken(sessionId) });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("Widget call finalization failed", error);
    return Response.json({ error: "Could not confirm the call ended." }, { status: 500 });
  }
}
