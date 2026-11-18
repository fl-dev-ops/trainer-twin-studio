import { z } from "zod";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { publicRequestBody } from "@/lib/public-twin-request";
import { bootstrapWidget } from "@/lib/widget-access";

const bodySchema = z.object({ parentOrigin: z.string().min(1).max(300), visitorToken: z.string().max(2048).optional() }).strict();
export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const parsed = bodySchema.safeParse(await publicRequestBody(request, 4096));
    if (!parsed.success) throw refusals.invalidInput("Invalid widget request.");
    const { agentId } = await context.params;
    return Response.json(await bootstrapWidget(request, { agentId, ...parsed.data }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("Widget bootstrap failed", error);
    return Response.json({ error: "Could not connect this widget." }, { status: 500 });
  }
}
