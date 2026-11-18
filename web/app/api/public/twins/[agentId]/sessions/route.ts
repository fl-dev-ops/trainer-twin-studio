import { z } from "zod";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { publicVisitorNameSchema } from "@/lib/public-twin-settings";
import { publicRequestBody, publicRequestIdentity } from "@/lib/public-twin-request";
import { startPublicTwinSession } from "@/lib/public-twin-sessions";

const bodySchema = z.object({ name: publicVisitorNameSchema }).strict();

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const body = bodySchema.safeParse(await publicRequestBody(request));
    if (!body.success) throw refusals.invalidInput(body.error.issues[0].message);
    const identity = await publicRequestIdentity(request, true);
    const { agentId } = await context.params;
    return Response.json(await startPublicTwinSession({ ...identity, agentId, name: body.data.name }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("Public call activation failed", error);
    return Response.json({ error: "Could not start the call. Please try again later." }, { status: 500 });
  }
}
