import { AppError, errorResponse } from "@/lib/errors";
import { publicRequestIdentity } from "@/lib/public-twin-request";
import { endPublicTwinSession } from "@/lib/public-twin-sessions";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const identity = await publicRequestIdentity(request, false);
    const { sessionId } = await context.params;
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    await endPublicTwinSession({ ...identity, sessionId, token });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("Public call finalization failed", error);
    return Response.json({ error: "Could not confirm the call ended. Please try again." }, { status: 500 });
  }
}
