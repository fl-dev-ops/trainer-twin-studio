import { z } from "zod";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { publicRequestBody } from "@/lib/public-twin-request";
import { publicVisitorNameSchema } from "@/lib/public-twin-settings";
import { widgetBearer, widgetRequestIp, widgetRequestOrg } from "@/lib/widget-access";
import { readWidgetGrant, widgetCredentialInvalid, widgetEndToken } from "@/lib/widget-tokens";
import { startPublicTwinSession } from "@/lib/public-twin-sessions";

const bodySchema = z.object({ name: publicVisitorNameSchema }).strict();
export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const org = await widgetRequestOrg(request);
    const { agentId } = await context.params;
    const grant = readWidgetGrant(widgetBearer(request));
    if (grant.orgId !== org.id || grant.agentId !== agentId) throw widgetCredentialInvalid();
    const body = bodySchema.safeParse(await publicRequestBody(request));
    if (!body.success) throw refusals.invalidInput("Enter a name using 1–80 characters without control characters.");
    const launch = await startPublicTwinSession({
      orgId: org.id, agentId, name: body.data.name, visitorId: grant.visitorId,
      ipHash: widgetRequestIp(request, org.id), embedOrigin: grant.parentOrigin, grantExpiresAt: grant.expiresAt,
    });
    return Response.json({
      ...launch,
      session: { ...launch.session, embedToken: widgetEndToken({
        orgId: org.id, agentId, parentOrigin: grant.parentOrigin, visitorId: grant.visitorId, sessionId: launch.session.id,
      }) },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("Widget call activation failed", error);
    return Response.json({ error: "Could not start the call. Please try again later." }, { status: 500 });
  }
}
